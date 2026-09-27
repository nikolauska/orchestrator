import type { CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, readFile, rm } from "node:fs/promises";
import {
  abortRebaseBestEffort,
  createDraftPullRequest,
  currentBranchAt,
  fastForward,
  headAt,
  isAncestor,
  pushHead,
  rebaseOnto,
  statusAt,
} from "../../runtime/git";
import {
  closeWorkerSpace,
  createTab,
  getAgent,
  interruptAgent,
  promptAgent,
  readAgent,
  startOmpAgent,
  waitForAgent,
  waitForShell,
} from "../../runtime/herdr";
import { lastResponse } from "../../runtime/session";
import { projectSpace, researchSpace, workerLabel } from "../../runtime/spaces";
import { WorkerStore } from "../../runtime/store";
import { returnLease } from "../../runtime/treehouse";
import {
  errorMessage,
  NAME,
  text,
  type RuntimeDeps,
  type ToolAPI,
  type ToolFactory,
  type WorkerRecord,
  type WorkersParams,
} from "../../runtime/shared";

export type WorkerState = {
  deps: RuntimeDeps;
  root: string;
  env: Record<string, string | undefined>;
  neutralRoot: string;
  records: Map<string, WorkerRecord>;
  store: WorkerStore;
  resuming?: Promise<void>;
  deliveryQueue: Promise<void>;
  spaceQueue: Promise<void>;
  active: boolean;
  /** Identifies this session in the store's owner row. */
  token: string;
  owner: boolean;
};

// Matches Firstmate's inspection-only thresholds: a silent screen for 4 minutes suggests a hung
// tool call, and a single turn past an hour deserves a look even while the screen still moves.
const CHECK_MS = 60_000;
const STALE_MS = 240_000;
const TURN_MS = 3_600_000;
const SCREEN_LINES = 40;
const MAX_READ_LINES = 200;
const UNTIL_STOPPED = ["idle", "done", "blocked"];
const UNTIL_UNBLOCKED = ["working", "idle", "done"];
const RELAUNCH_NOTE =
  "Recovery relaunch: an earlier agent worked on this assignment in this same directory and stopped before finishing. Continue from the existing state (files, `git status`, `git log`) and keep its changes and commits; the finish line above is unchanged.";

const states = new WeakMap<ToolAPI, WorkerState>();

export function stateFor(pi: ToolAPI): WorkerState {
  const existing = states.get(pi);
  if (existing) return existing;

  const state: WorkerState = {
    deps: { exec: pi.exec, logger: pi.logger, sendMessage: pi.sendMessage },
    root: pi.cwd,
    env: pi.env ?? process.env,
    neutralRoot: pi.neutralRoot ?? join(homedir(), ".omp", "orchestrator", "independent-workers"),
    records: new Map(),
    store: new WorkerStore(join(pi.cwd, ".omp", "orchestrator.db")),
    deliveryQueue: Promise.resolve(),
    spaceQueue: Promise.resolve(),
    active: true,
    token: crypto.randomUUID(),
    owner: false,
  };
  states.set(pi, state);
  return state;
}

export function isCurrent(state: WorkerState, record: WorkerRecord): boolean {
  return state.active && state.records.get(record.name) === record;
}

export function notify(
  state: WorkerState,
  outcome: Record<string, unknown>,
  heading = "Visible worker result",
): void {
  if (!state.active) return;
  state.deps.sendMessage(`${heading}:\n${JSON.stringify(outcome, null, 2)}`, {
    triggerTurn: true,
    deliverAs: "nextTurn",
  });
}

export function hasWorker(state: WorkerState, name: string): boolean {
  return state.records.has(name);
}

export function publicRecord(record: WorkerRecord): Record<string, unknown> {
  return {
    kind: record.kind,
    ...(record.scope === "independent" ? { scope: "independent" } : { project: record.project }),
    name: record.name,
    ...(record.role ? { role: record.role } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    status: record.status,
    ...(record.launched_at ? { launched_at: record.launched_at } : {}),
    ...(record.updated_at ? { updated_at: record.updated_at } : {}),
    workspace_id: record.workspace_id,
    tab_id: record.tab_id,
    pane_id: record.pane_id,
    ...(record.scope === "independent"
      ? { working_directory: record.working_directory }
      : {
          worktree: record.worktree,
          lease_id: record.lease_id,
          delivery_base: record.delivery_base,
        }),
    ...(record.start_from ? { start_from: record.start_from } : {}),
    ...(record.push_to ? { push_to: record.push_to } : {}),
    ...(record.hold ? { hold: true } : {}),
    ...(record.pr ? { pr: true } : {}),
    ...(record.report_path
      ? {
          report_path: record.report_path,
          ...(record.scope === "project" ? { local_changes: record.local_changes ?? "" } : {}),
        }
      : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

/** Writes the record to the durable store while this session still owns it. */
export function persist(state: WorkerState, record: WorkerRecord): void {
  if (isCurrent(state, record)) state.store.save(record);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Makes this session the supervisor unless another live session already is. */
export function claimOwnership(state: WorkerState): boolean {
  state.owner = state.store.claim(state.token, process.pid, processAlive).token === state.token;
  return state.owner;
}

/** Mutations from a second session would double-deliver and double-close the same workers. */
export function requireOwnership(state: WorkerState): void {
  if (claimOwnership(state)) return;
  const owner = state.store.owner();
  throw new Error(
    `Another OMP session (pid ${owner?.pid}) has supervised these workers since ${owner?.claimed_at}; this session is read-only until that session exits`,
  );
}

export function adoptWorker(state: WorkerState, record: WorkerRecord, status: string): void {
  state.records.set(record.name, record);
  state.store.save(record);
  observe(state, record, status, true);
}

export function disposeWorkers(state: WorkerState): void {
  state.active = false;
  state.resuming = undefined;
  for (const record of state.records.values()) record.watch?.abort();
  // Durable rows stay: the next session resumes the same workers.
  state.records.clear();
  if (state.owner) state.store.release(state.token);
  state.owner = false;
}

/** Re-attaches workers recorded by an earlier OMP session; concurrent callers share one pass. */
export function resumeWorkers(state: WorkerState): Promise<void> {
  if (!state.owner) return Promise.resolve();
  state.resuming ??= Promise.all(
    state.store
      .all()
      .filter((record) => !state.records.has(record.name))
      .map((record) => resumeWorker(state, record)),
  ).then(() => undefined);
  return state.resuming;
}

export function handleSession(state: WorkerState, reason: string): void {
  if (reason === "switch" || reason === "shutdown") disposeWorkers(state);
  if (reason === "start" || reason === "switch") {
    state.active = true;
    // Resume without waiting for a tool call so finished workers still deliver and wake the root.
    if (claimOwnership(state)) void resumeWorkers(state);
  }
}

async function resumeWorker(state: WorkerState, record: WorkerRecord): Promise<void> {
  state.records.set(record.name, record);
  // Failed, interrupted, and held workers wait for an explicit root decision.
  if (record.status === "failed" || record.status === "interrupted" || record.status === "ready")
    return;
  try {
    const agent = await getAgent(state.deps, record.pane_id);
    if (!isCurrent(state, record)) return;
    if (agent.identity !== "omp")
      throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
    // A question announced before the restart is not announced again.
    observe(state, record, agent.status, record.status !== "blocked");
  } catch (error) {
    if (!isCurrent(state, record)) return;
    record.status = "failed";
    record.error = `Worker could not be resumed: ${errorMessage(error)}`;
    persist(state, record);
    notify(state, terminal(record, "failed", "", { error: record.error }));
  }
}

/** Acts on an observed agent status: supervise it, settle it, or surface its question. */
function observe(
  state: WorkerState,
  record: WorkerRecord,
  status: string,
  announce: boolean,
): void {
  if (status === "working") {
    record.error = undefined;
    setStatus(state, record, "working");
    watchWorker(state, record);
  } else if (status === "idle" || status === "done") void settleWorker(state, record);
  else if (status === "blocked") {
    setStatus(state, record, "blocked");
    if (announce) void announceBlocked(state, record);
    // Keep watching so an answer typed directly in the worker's tab still leads to delivery.
    watchWorker(state, record);
  } else throw new Error(`Unexpected Herdr agent status: ${status}`);
}

// Persisting only real transitions keeps updated_at meaning "entered this status".
function setStatus(state: WorkerState, record: WorkerRecord, status: WorkerRecord["status"]): void {
  if (record.status === status) return;
  record.status = status;
  persist(state, record);
}

async function screenOf(
  state: WorkerState,
  record: WorkerRecord,
  lines: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await readAgent(state.deps, record.pane_id, lines, signal);
  } catch (error) {
    return `Worker screen unavailable: ${errorMessage(error)}`;
  }
}

async function announceBlocked(state: WorkerState, record: WorkerRecord): Promise<void> {
  const screen = await screenOf(state, record, SCREEN_LINES);
  if (isCurrent(state, record) && record.status === "blocked")
    notify(state, terminal(record, "blocked", screen));
}

export async function runWorkers(
  state: WorkerState,
  params: WorkersParams,
  signal?: AbortSignal,
): Promise<CustomToolResult> {
  state.active = true;
  try {
    const owner = claimOwnership(state);
    if (owner) await resumeWorkers(state);
    // A non-owner may still look: it reads the durable registry without supervising anything.
    const known = owner
      ? state.records
      : new Map(state.store.all().map((record) => [record.name, record]));
    if (params.op === "list") {
      const records = [...known.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(publicRecord);
      const heading = owner
        ? "Visible workers"
        : `Visible workers (read-only; OMP session pid ${state.store.owner()?.pid} supervises them)`;
      return text(`${heading}:\n${JSON.stringify(records, null, 2)}`, records);
    }
    if (
      !Array.isArray(params.names) ||
      params.names.length === 0 ||
      new Set(params.names).size !== params.names.length
    )
      throw new Error("Worker names must be a non-empty unique list");
    if (params.op === "send" && !params.message?.trim())
      throw new Error("Worker message must be non-empty");
    if (params.op === "relaunch" && !params.note?.trim())
      throw new Error("Relaunch note must be non-empty");
    // Strict tool transport can materialize an omitted number as 0; treat it as the default.
    if (
      params.op === "read" &&
      params.lines &&
      (!Number.isInteger(params.lines) || params.lines < 1 || params.lines > MAX_READ_LINES)
    )
      throw new Error(`Read lines must be an integer from 1 to ${MAX_READ_LINES}`);
    const records = params.names.map((name) => {
      if (!NAME.test(name)) throw new Error(`Invalid worker name: ${name}`);
      const record = known.get(name);
      if (!record) throw new Error(`Unknown visible worker: ${name}`);
      return record;
    });
    if (params.op === "read") {
      const lines = params.lines || SCREEN_LINES;
      const screens = await Promise.all(
        records.map(async (record) => ({
          name: record.name,
          status: record.status,
          screen: await screenOf(state, record, lines, signal),
        })),
      );
      return text(`Visible worker screens:\n${JSON.stringify(screens, null, 2)}`, screens);
    }
    requireOwnership(state);
    const run = {
      send: (record: WorkerRecord) =>
        sendWorker(state, record, (params as { message: string }).message, signal),
      interrupt: (record: WorkerRecord) => interruptWorker(state, record, signal),
      relaunch: (record: WorkerRecord) =>
        relaunchWorker(state, record, (params as { note: string }).note, signal),
      land: (record: WorkerRecord) => landWorker(state, record, signal),
      close: (record: WorkerRecord) =>
        closeWorker(state, record, (params as { discard?: boolean }).discard === true, signal),
    }[params.op];
    const outcomes = await Promise.all(records.map(run));
    return text(
      `Visible worker ${params.op} results:\n${JSON.stringify(outcomes, null, 2)}`,
      outcomes,
    );
  } catch (error) {
    return text(errorMessage(error), undefined, true);
  }
}

async function closeWorker(
  state: WorkerState,
  record: WorkerRecord,
  discard: boolean,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    if (!discard) {
      const unlanded = await unlandedWork(state, record, signal);
      if (unlanded)
        return {
          ...publicRecord(record),
          close: "refused",
          reason: `${unlanded}; pass discard: true to close anyway`,
        };
    }
    // Invalidate watchers first so the dying agent is not mistaken for a finished one.
    record.generation++;
    record.watch?.abort();
    await closeWorkerSpace(state.deps, record, signal);
    if (!discard) {
      // The agent could have changed the checkout between the first check and closing its space.
      const unlanded = await unlandedWork(state, record, signal);
      if (unlanded) {
        record.status = "failed";
        record.error = `Space closed but checkout retained: ${unlanded}`;
        persist(state, record);
        return { ...publicRecord(record), close: "retained", reason: record.error };
      }
    }
    await releaseWorker(state, record);
    state.records.delete(record.name);
    state.store.delete(record.name);
    return { ...publicRecord(record), close: "closed" };
  } catch (error) {
    record.status = "failed";
    record.error = `Close failed: ${errorMessage(error)}`;
    persist(state, record);
    return { ...publicRecord(record), close: "failed" };
  }
}

async function unlandedWork(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<string> {
  // Scout checkouts and neutral folders are disposable by contract; their reports live elsewhere.
  if (record.kind !== "implementation") return "";
  const [dirty, current] = await Promise.all([
    statusAt(state.deps, record.worktree!, signal),
    headAt(state.deps, record.worktree!, signal),
  ]);
  // A delivered commit can remain in a retained checkout when closing its Herdr space failed.
  const projectHead =
    current !== record.delivery_base && !record.push_to
      ? await headAt(state.deps, record.projectPath!, signal)
      : undefined;
  const delivered =
    current === record.delivery_base ||
    (projectHead !== undefined &&
      (current === projectHead ||
        (await isAncestor(state.deps, record.projectPath!, current, projectHead, signal))));
  return [
    dirty ? `uncommitted changes in ${record.worktree}` : "",
    !delivered
      ? `undelivered commits (HEAD ${current}, delivery base ${record.delivery_base})`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
}

async function releaseWorker(state: WorkerState, record: WorkerRecord): Promise<void> {
  if (record.scope === "independent") {
    if (!record.working_directory) throw new Error("Independent working directory is missing");
    await rm(record.working_directory, { recursive: true, force: true });
  } else {
    await returnLease(state.deps, {
      path: record.worktree!,
      leaseId: record.lease_id!,
      leaseHolder: record.lease_holder!,
    });
  }
}

async function sendWorker(
  state: WorkerState,
  record: WorkerRecord,
  message: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  record.generation++;
  record.watch?.abort();
  try {
    await promptAgent(state.deps, record.pane_id, message, signal);
  } catch (error) {
    record.error = errorMessage(error);
  }
  try {
    const agent = await getAgent(state.deps, record.pane_id, signal);
    if (agent.identity !== "omp")
      throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
    observe(state, record, agent.status, true);
  } catch (error) {
    record.status = "failed";
    record.error = errorMessage(error);
    notify(state, terminal(record, "failed", "", { error: record.error }));
  }
  persist(state, record);
  return publicRecord(record);
}

async function interruptWorker(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (record.status !== "working" && record.status !== "blocked")
    return {
      ...publicRecord(record),
      interrupt: "refused",
      reason: `Worker is ${record.status}, not running`,
    };
  // Stop supervising first: the idle state after Escape is not a finished assignment.
  record.generation++;
  record.watch?.abort();
  try {
    await interruptAgent(state.deps, record.pane_id, signal);
  } catch (error) {
    watchWorker(state, record);
    return { ...publicRecord(record), interrupt: "failed", reason: errorMessage(error) };
  }
  setStatus(state, record, "interrupted");
  return { ...publicRecord(record), interrupt: "sent" };
}

async function relaunchWorker(
  state: WorkerState,
  record: WorkerRecord,
  note: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!record.prompt)
    return {
      ...publicRecord(record),
      relaunch: "refused",
      reason: "The original assignment was not recorded for this worker",
    };
  record.generation++;
  record.watch?.abort();
  const directory = record.worktree ?? record.working_directory!;
  try {
    // Closing the old space stops a wedged agent; the checkout and its work stay untouched.
    await closeWorkerSpace(state.deps, record, signal);
    const label = workerLabel(record.kind, record.name);
    let workspaceId: string;
    let tab;
    if (record.scope === "project") {
      const space = await projectSpace(
        state,
        record.project!,
        record.projectPath!,
        directory,
        label,
        signal,
      );
      workspaceId = space.workspaceId;
      tab = space;
    } else {
      workspaceId = await researchSpace(state, signal);
      tab = await createTab(state.deps, workspaceId, directory, label, signal);
    }
    record.workspace_id = workspaceId;
    record.tab_id = tab.tabId;
    record.pane_id = tab.paneId;
    // Record the new space before starting OMP so a later failure still points at it.
    persist(state, record);
    await waitForShell(state.deps, record.pane_id, signal);
    await startOmpAgent(state.deps, record.name, record.pane_id, directory, record, signal);
    await promptAgent(
      state.deps,
      record.pane_id,
      `${record.prompt}\n\n${RELAUNCH_NOTE}\nNote from the orchestrator: ${note}`,
      signal,
    );
    const agent = await getAgent(state.deps, record.pane_id, signal);
    if (agent.identity !== "omp")
      throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
    record.error = undefined;
    observe(state, record, agent.status, true);
    persist(state, record);
    return { ...publicRecord(record), relaunch: "started" };
  } catch (error) {
    record.status = "failed";
    record.error = `Relaunch failed: ${errorMessage(error)}`;
    persist(state, record);
    return { ...publicRecord(record), relaunch: "failed" };
  }
}

function watchWorker(state: WorkerState, record: WorkerRecord): void {
  record.watch?.abort();
  const generation = ++record.generation;
  const controller = new AbortController();
  record.watch = controller;
  const superseded = () =>
    controller.signal.aborted || !isCurrent(state, record) || record.generation !== generation;
  void (async () => {
    try {
      for (;;) {
        const blocked = record.status === "blocked";
        const stopMonitor = blocked ? undefined : monitorProgress(state, record, superseded);
        try {
          await waitForAgent(
            state.deps,
            record.pane_id,
            controller.signal,
            blocked ? UNTIL_UNBLOCKED : UNTIL_STOPPED,
          );
        } finally {
          stopMonitor?.();
        }
        if (superseded()) return;
        const agent = await getAgent(state.deps, record.pane_id, controller.signal);
        if (superseded()) return;
        if (agent.status === "idle" || agent.status === "done") {
          await settleWorker(state, record);
          return;
        }
        if (agent.status === "working") setStatus(state, record, "working");
        else if (agent.status === "blocked") {
          if (record.status !== "blocked") {
            setStatus(state, record, "blocked");
            void announceBlocked(state, record);
          }
        } else throw new Error(`Watcher observed unexpected state: ${agent.status}`);
      }
    } catch (error) {
      if (superseded()) return;
      record.status = "failed";
      record.error = errorMessage(error);
      persist(state, record);
      notify(state, terminal(record, "failed", "", { error: record.error }));
    }
  })();
}

/**
 * Nudges the root once when a working worker's screen stops changing and once when its turn runs
 * past the long-turn threshold. Inspection only: it never interrupts or restarts the worker.
 */
function monitorProgress(
  state: WorkerState,
  record: WorkerRecord,
  superseded: () => boolean,
): () => void {
  const turnStarted = Date.parse(record.updated_at ?? "") || Date.now();
  let screen: string | undefined;
  let changedAt = Date.now();
  let staleSent = false;
  let turnSent = false;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const current = await screenOf(state, record, SCREEN_LINES);
      if (superseded()) return;
      const now = Date.now();
      if (current !== screen) {
        screen = current;
        changedAt = now;
        staleSent = false;
      }
      const notice = (kind: string, detail: string) =>
        notify(
          state,
          { ...publicRecord(record), notice: kind, detail, output: current },
          "Visible worker notice",
        );
      if (!staleSent && now - changedAt >= STALE_MS) {
        staleSent = true;
        notice("no_progress", `Screen unchanged for ${Math.round((now - changedAt) / 1000)} s`);
      }
      if (!turnSent && now - turnStarted >= TURN_MS) {
        turnSent = true;
        notice("long_turn", `Working for ${Math.round((now - turnStarted) / 1000)} s`);
      }
    } finally {
      checking = false;
    }
  }, CHECK_MS);
  return () => clearInterval(timer);
}

async function settleWorker(state: WorkerState, record: WorkerRecord): Promise<void> {
  const generation = ++record.generation;
  try {
    const output = await workerResponse(state, record);
    if (record.generation !== generation || !isCurrent(state, record)) return;
    let outcome: Record<string, unknown>;
    if (record.kind === "scout") {
      outcome = await completeScout(record, output);
    } else {
      const dirty = await statusAt(state.deps, record.worktree!);
      if (dirty) throw new Error("Worker worktree contains uncommitted changes");
      if (record.hold) {
        const head = await headAt(state.deps, record.worktree!);
        if (head !== record.delivery_base) {
          if (record.generation !== generation || !isCurrent(state, record)) return;
          record.error = undefined;
          setStatus(state, record, "ready");
          notify(
            state,
            terminal(record, "ready", output, { head, delivery_base: record.delivery_base }),
          );
          return;
        }
      }
      outcome = await deliverWorker(state, record, output);
    }
    if (record.generation === generation && isCurrent(state, record))
      await finishWorker(state, record, outcome, true);
  } catch (error) {
    if (record.generation !== generation || !isCurrent(state, record)) return;
    record.status = "failed";
    record.error = errorMessage(error);
    persist(state, record);
    notify(state, terminal(record, "failed", "", { error: record.error }));
  }
}

/** Delivers a held implementation after review; the outcome is returned instead of announced. */
async function landWorker(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (record.status !== "ready")
    return {
      ...publicRecord(record),
      land: "refused",
      reason: `Worker is ${record.status}, not ready to land`,
    };
  const generation = ++record.generation;
  try {
    // The user may have resumed the agent in its tab after review; never land moving work.
    const agent = await getAgent(state.deps, record.pane_id, signal);
    if (agent.status === "working" || agent.status === "blocked")
      return {
        ...publicRecord(record),
        land: "refused",
        reason: `Worker agent is ${agent.status} again; send it a message to resume supervision`,
      };
    if (await statusAt(state.deps, record.worktree!, signal))
      throw new Error("Worker worktree contains uncommitted changes");
    const output = await workerResponse(state, record);
    const outcome = await deliverWorker(state, record, output);
    if (record.generation !== generation || !isCurrent(state, record)) return outcome;
    return await finishWorker(state, record, outcome, false);
  } catch (error) {
    record.status = "failed";
    record.error = errorMessage(error);
    persist(state, record);
    return terminal(record, "failed", "", { error: record.error });
  }
}

// The response is informational; delivery must not depend on being able to read it.
async function workerResponse(state: WorkerState, record: WorkerRecord): Promise<string> {
  try {
    const { sessionPath } = await getAgent(state.deps, record.pane_id);
    if (!sessionPath) return "Worker response unavailable: Herdr reported no session path";
    return (
      (await lastResponse(sessionPath)) ??
      `Worker response unavailable: no assistant response in ${sessionPath}`
    );
  } catch (error) {
    return `Worker response unavailable: ${errorMessage(error)}`;
  }
}

async function completeScout(
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  const path = record.report_path;
  if (!path) throw new Error("Scout report path is missing");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new Error(`Scout report is missing or unreadable: ${path}: ${errorMessage(error)}`);
  }
  if (!info.isFile()) throw new Error(`Scout report is not a regular file: ${path}`);
  let report: string;
  try {
    report = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Scout report is unreadable: ${path}: ${errorMessage(error)}`);
  }
  if (!report.trim()) throw new Error(`Scout report is empty: ${path}`);
  return terminal(record, "completed_with_report", output, { report });
}

function deliverWorker(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  return record.push_to ? pushWorker(state, record, output) : queueLocal(state, record, output);
}

async function pushWorker(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  await pushHead(state.deps, record.worktree!, record.push_to!);
  if (!record.pr) return terminal(record, "pushed", output, { branch: record.push_to });
  try {
    const url = await createDraftPullRequest(
      state.deps,
      record.worktree!,
      record.push_to!,
      record.start_from,
    );
    return terminal(record, "pushed", output, { branch: record.push_to, pr_url: url });
  } catch (error) {
    // The branch is already pushed, so the work is delivered; the PR or MR can still be opened by hand.
    return terminal(record, "pushed", output, {
      branch: record.push_to,
      pr_error: errorMessage(error),
    });
  }
}

function queueLocal(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  let resolveOutcome!: (value: Record<string, unknown>) => void;
  let rejectOutcome!: (reason: unknown) => void;
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  state.deliveryQueue = state.deliveryQueue.then(async () => {
    try {
      resolveOutcome(await deliverLocal(state, record, output));
    } catch (error) {
      rejectOutcome(error);
    }
  }, rejectOutcome);
  return result;
}

async function deliverLocal(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  const workerHead = await headAt(state.deps, record.worktree!);
  if (workerHead === record.delivery_base)
    return terminal(record, "no_changes", output, { branch: record.branch });
  await assertTarget(state, record);
  try {
    await fastForward(state.deps, record.projectPath!, workerHead);
  } catch (firstError) {
    const current = await headAt(state.deps, record.projectPath!);
    if (current === record.delivery_base) throw firstError;
    try {
      await rebaseOnto(state.deps, record.worktree!, current, record.delivery_base!, workerHead);
    } catch (error) {
      await abortRebaseBestEffort(state.deps, record.worktree!);
      throw error;
    }
    record.delivery_base = current;
    persist(state, record);
    const rebasedHead = await headAt(state.deps, record.worktree!);
    await assertTarget(state, record);
    await fastForward(state.deps, record.projectPath!, rebasedHead);
  }
  return terminal(record, "merged", output, { branch: record.branch });
}

async function assertTarget(state: WorkerState, record: WorkerRecord): Promise<void> {
  const dirty = await statusAt(state.deps, record.projectPath!);
  if (dirty) throw new Error("Registered project became dirty before delivery");
  const branch = await currentBranchAt(state.deps, record.projectPath!);
  if (!branch || branch !== record.branch)
    throw new Error(
      `Registered project branch changed before delivery (expected ${record.branch})`,
    );
}

async function finishWorker(
  state: WorkerState,
  record: WorkerRecord,
  outcome: Record<string, unknown>,
  announce: boolean,
): Promise<Record<string, unknown>> {
  if (!isCurrent(state, record)) return outcome;
  try {
    await closeWorkerSpace(state.deps, record);
    if (!isCurrent(state, record)) return outcome;
    await releaseWorker(state, record);
    state.records.delete(record.name);
    state.store.delete(record.name);
    if (announce) notify(state, outcome);
    return outcome;
  } catch (error) {
    record.status = "failed";
    record.error = `Cleanup failed: ${errorMessage(error)}`;
    persist(state, record);
    const failure = terminal(record, "failed", String(outcome.output ?? ""), {
      error: record.error,
    });
    if (announce) notify(state, failure);
    return failure;
  }
}

function terminal(
  record: WorkerRecord,
  status:
    | "merged"
    | "pushed"
    | "no_changes"
    | "completed_with_report"
    | "ready"
    | "blocked"
    | "failed",
  output: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: record.kind,
    ...(record.scope === "independent" ? { scope: "independent" } : { project: record.project }),
    name: record.name,
    ...(record.role ? { role: record.role } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    status,
    output,
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined)),
    ...(record.report_path
      ? {
          report_path: record.report_path,
          ...(record.scope === "project" ? { local_changes: record.local_changes ?? "" } : {}),
        }
      : {}),
    workspace_id: record.workspace_id,
    tab_id: record.tab_id,
    pane_id: record.pane_id,
    ...(record.scope === "independent"
      ? { working_directory: record.working_directory }
      : { worktree: record.worktree, lease_id: record.lease_id }),
  };
}

const workersTool: ToolFactory = (pi) => {
  const state = stateFor(pi);
  const z = pi.zod;
  const names = z.array(z.string()).min(1);

  return {
    name: "workers",
    label: "Workers",
    loadMode: "essential",
    approval: "exec",
    description:
      "Supervise workers launched by orchestrator_task; use it instead of hub. Ops: list; read recent screen lines; send an answer or changed requirement; interrupt a running turn (send resumes it); relaunch a dead or stuck worker in its same worktree with a recovery note; land a held implementation that is ready; close workers. close refuses implementation work that is uncommitted or undelivered unless discard is true. Only the supervising OMP session can change workers; other sessions can list and read.",
    parameters: z.union([
      z.object({ op: z.literal("list") }).strict(),
      z
        .object({
          op: z.literal("read"),
          names,
          lines: z.number().int().min(1).max(MAX_READ_LINES).optional(),
        })
        .strict(),
      z.object({ op: z.literal("send"), names, message: z.string() }).strict(),
      z.object({ op: z.literal("interrupt"), names }).strict(),
      z.object({ op: z.literal("relaunch"), names, note: z.string() }).strict(),
      z.object({ op: z.literal("land"), names }).strict(),
      z.object({ op: z.literal("close"), names, discard: z.boolean().optional() }).strict(),
    ]),
    execute: async (_id, params, signal) => runWorkers(state, params as WorkersParams, signal),
    onSession: (event) => handleSession(state, event.reason),
  };
};

export default workersTool;
