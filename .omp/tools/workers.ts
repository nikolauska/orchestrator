import type { CustomToolAPI, CustomToolFactory, CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, readFile, rm } from "node:fs/promises";
import {
  abortRebaseBestEffort,
  currentBranchAt,
  fastForward,
  headAt,
  isAncestor,
  pushHead,
  rebaseOnto,
  statusAt,
} from "../runtime/git";
import { closeWorkerSpace, getAgent, promptAgent, readAgent, waitForAgent } from "../runtime/herdr";
import { WorkerStore } from "../runtime/store";
import { returnLease } from "../runtime/treehouse";
import {
  errorMessage,
  NAME,
  text,
  type RuntimeDeps,
  type WorkerRecord,
  type WorkersParams,
} from "../runtime/shared";

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
};

type RuntimeAPI = CustomToolAPI & {
  sendMessage?: RuntimeDeps["sendMessage"];
  env?: Record<string, string | undefined>;
  neutralRoot?: string;
};

const states = new WeakMap<CustomToolAPI, WorkerState>();

export function stateFor(pi: CustomToolAPI): WorkerState {
  const existing = states.get(pi);
  if (existing) return existing;

  const candidate = pi as RuntimeAPI;
  const sendMessage = candidate.sendMessage
    ? candidate.sendMessage.bind(pi)
    : (message: string) => pi.ui.notify(message, "info");
  const state: WorkerState = {
    deps: { exec: pi.exec, logger: pi.logger, sendMessage },
    root: pi.cwd,
    env: candidate.env ?? process.env,
    neutralRoot:
      candidate.neutralRoot ?? join(homedir(), ".omp", "orchestrator", "independent-workers"),
    records: new Map(),
    store: new WorkerStore(join(pi.cwd, ".omp", "orchestrator.db")),
    deliveryQueue: Promise.resolve(),
    spaceQueue: Promise.resolve(),
    active: true,
  };
  states.set(pi, state);
  return state;
}

export function isCurrent(state: WorkerState, record: WorkerRecord): boolean {
  return state.active && state.records.get(record.name) === record;
}

export function notify(state: WorkerState, outcome: Record<string, unknown>): void {
  if (!state.active) return;
  state.deps.sendMessage(`Visible worker result:\n${JSON.stringify(outcome, null, 2)}`, {
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
    status: record.status,
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
    ...(record.push_to ? { push_to: record.push_to } : {}),
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

export function adoptWorker(state: WorkerState, record: WorkerRecord, status: string): void {
  state.records.set(record.name, record);
  state.store.save(record);
  if (status === "working") watchWorker(state, record);
  else if (status === "idle" || status === "done") void settleWorker(state, record);
  else if (status === "blocked")
    queueMicrotask(() => notify(state, terminal(record, "blocked", "")));
  else throw new Error(`Unexpected Herdr agent status: ${status}`);
}

export function disposeWorkers(state: WorkerState): void {
  state.active = false;
  state.resuming = undefined;
  for (const record of state.records.values()) record.watch?.abort();
  // Durable rows stay: the next session resumes the same workers.
  state.records.clear();
}

/** Re-attaches workers recorded by an earlier OMP session; concurrent callers share one pass. */
export function resumeWorkers(state: WorkerState): Promise<void> {
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
    void resumeWorkers(state);
  }
}

async function resumeWorker(state: WorkerState, record: WorkerRecord): Promise<void> {
  state.records.set(record.name, record);
  // A failure was already reported; retrying it stays an explicit send or close decision.
  if (record.status === "failed") return;
  try {
    const agent = await getAgent(state.deps, record.pane_id);
    if (!isCurrent(state, record)) return;
    if (agent.identity !== "omp")
      throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
    if (agent.status === "working") {
      record.status = "working";
      persist(state, record);
      watchWorker(state, record);
    } else if (agent.status === "idle" || agent.status === "done") void settleWorker(state, record);
    else if (agent.status === "blocked") {
      if (record.status === "blocked") return;
      record.status = "blocked";
      persist(state, record);
      notify(state, terminal(record, "blocked", ""));
    } else throw new Error(`Unexpected Herdr agent status: ${agent.status}`);
  } catch (error) {
    if (!isCurrent(state, record)) return;
    record.status = "failed";
    record.error = `Worker could not be resumed: ${errorMessage(error)}`;
    persist(state, record);
    notify(state, terminal(record, "failed", "", record.error));
  }
}

export async function runWorkers(
  state: WorkerState,
  params: WorkersParams,
  signal?: AbortSignal,
): Promise<CustomToolResult> {
  state.active = true;
  try {
    await resumeWorkers(state);
    if (params.op === "list") {
      const records = [...state.records.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(publicRecord);
      return text(`Visible workers:\n${JSON.stringify(records, null, 2)}`, records);
    }
    if (
      !Array.isArray(params.names) ||
      params.names.length === 0 ||
      new Set(params.names).size !== params.names.length
    )
      throw new Error("Worker names must be a non-empty unique list");
    if (params.op === "send" && !params.message?.trim())
      throw new Error("Worker message must be non-empty");
    const records = params.names.map((name) => {
      if (!NAME.test(name)) throw new Error(`Invalid worker name: ${name}`);
      const record = state.records.get(name);
      if (!record) throw new Error(`Unknown visible worker: ${name}`);
      return record;
    });
    if (params.op === "close") {
      const discard = params.discard === true;
      const outcomes = await Promise.all(
        records.map((record) => closeWorker(state, record, discard, signal)),
      );
      return text(`Visible worker close results:\n${JSON.stringify(outcomes, null, 2)}`, outcomes);
    }
    const message = params.message;
    const outcomes = await Promise.all(
      records.map((record) => sendWorker(state, record, message, signal)),
    );
    return text(`Visible worker messages:\n${JSON.stringify(outcomes, null, 2)}`, outcomes);
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
    if (agent.status === "working") {
      record.status = "working";
      record.error = undefined;
      watchWorker(state, record);
    } else if (agent.status === "idle" || agent.status === "done") void settleWorker(state, record);
    else if (agent.status === "blocked") {
      record.status = "blocked";
      queueMicrotask(() => notify(state, terminal(record, "blocked", "")));
    } else throw new Error(`Unexpected Herdr agent status: ${agent.status}`);
  } catch (error) {
    record.status = "failed";
    record.error = errorMessage(error);
    notify(state, terminal(record, "failed", "", record.error));
  }
  persist(state, record);
  return publicRecord(record);
}

function watchWorker(state: WorkerState, record: WorkerRecord): void {
  const generation = ++record.generation;
  const controller = new AbortController();
  record.watch = controller;
  void (async () => {
    try {
      await waitForAgent(state.deps, record.pane_id, controller.signal);
      if (!isCurrent(state, record) || record.generation !== generation) return;
      const agent = await getAgent(state.deps, record.pane_id, controller.signal);
      if (!isCurrent(state, record) || record.generation !== generation) return;
      if (agent.status === "idle" || agent.status === "done") await settleWorker(state, record);
      else if (agent.status === "blocked") {
        record.status = "blocked";
        persist(state, record);
        notify(state, terminal(record, "blocked", ""));
      } else throw new Error(`Watcher observed unexpected state: ${agent.status}`);
    } catch (error) {
      if (
        controller.signal.aborted ||
        !isCurrent(state, record) ||
        record.generation !== generation
      )
        return;
      record.status = "failed";
      record.error = errorMessage(error);
      persist(state, record);
      notify(state, terminal(record, "failed", "", record.error));
    }
  })();
}

async function settleWorker(state: WorkerState, record: WorkerRecord): Promise<void> {
  const generation = ++record.generation;
  try {
    const output = await readAgent(state.deps, record.pane_id);
    if (record.generation !== generation || !isCurrent(state, record)) return;
    let outcome: Record<string, unknown>;
    if (record.kind === "scout") {
      outcome = await completeScout(record, output);
    } else {
      const dirty = await statusAt(state.deps, record.worktree!);
      if (dirty) throw new Error("Worker worktree contains uncommitted changes");
      outcome = record.push_to
        ? await pushWorker(state, record, output)
        : await queueLocal(state, record, output);
    }
    if (record.generation === generation && isCurrent(state, record))
      await finishWorker(state, record, outcome);
  } catch (error) {
    if (record.generation !== generation || !isCurrent(state, record)) return;
    record.status = "failed";
    record.error = errorMessage(error);
    persist(state, record);
    notify(state, terminal(record, "failed", "", record.error));
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
  return terminal(record, "completed_with_report", output, undefined, undefined, report);
}

async function pushWorker(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  await pushHead(state.deps, record.worktree!, record.push_to!);
  return terminal(record, "pushed", output, undefined, record.push_to);
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
    return terminal(record, "no_changes", output, undefined, record.branch);
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
  return terminal(record, "merged", output, undefined, record.branch);
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
): Promise<void> {
  if (!isCurrent(state, record)) return;
  try {
    await closeWorkerSpace(state.deps, record);
    if (!isCurrent(state, record)) return;
    await releaseWorker(state, record);
    state.records.delete(record.name);
    state.store.delete(record.name);
    notify(state, outcome);
  } catch (error) {
    record.status = "failed";
    record.error = `Cleanup failed: ${errorMessage(error)}`;
    persist(state, record);
    notify(state, terminal(record, "failed", String(outcome.output ?? ""), record.error));
  }
}

function terminal(
  record: WorkerRecord,
  status: "merged" | "pushed" | "no_changes" | "completed_with_report" | "blocked" | "failed",
  output: string,
  error?: string,
  branch?: string,
  report?: string,
): Record<string, unknown> {
  return {
    kind: record.kind,
    ...(record.scope === "independent" ? { scope: "independent" } : { project: record.project }),
    name: record.name,
    ...(record.role ? { role: record.role } : {}),
    status,
    output,
    ...(branch ? { branch } : {}),
    ...(report ? { report } : {}),
    ...(record.report_path
      ? {
          report_path: record.report_path,
          ...(record.scope === "project" ? { local_changes: record.local_changes ?? "" } : {}),
        }
      : {}),
    ...(error ? { error } : {}),
    workspace_id: record.workspace_id,
    tab_id: record.tab_id,
    pane_id: record.pane_id,
    ...(record.scope === "independent"
      ? { working_directory: record.working_directory }
      : { worktree: record.worktree, lease_id: record.lease_id }),
  };
}

const workersTool: CustomToolFactory = (pi) => {
  const state = stateFor(pi);
  const z = pi.zod;

  return {
    name: "workers",
    label: "Workers",
    loadMode: "essential",
    approval: "exec",
    description:
      "List visible worker agents, send a plan change to named workers, or close named workers. Workers are recorded durably and resume after an OMP restart. Close stops the agent, closes its project worktree space or independent research tab, and releases its Treehouse worktree or neutral directory; it refuses implementation workers with uncommitted or undelivered commits unless discard is true. Parent project and research spaces remain open. Use this instead of hub for workers launched by orchestrator_task. Workers MUST NOT create new workers.",
    parameters: z.union([
      z.object({ op: z.literal("list") }).strict(),
      z
        .object({ op: z.literal("send"), names: z.array(z.string()).min(1), message: z.string() })
        .strict(),
      z
        .object({
          op: z.literal("close"),
          names: z.array(z.string()).min(1),
          discard: z.boolean().optional(),
        })
        .strict(),
    ]),
    execute: async (_id, params, _onUpdate, _ctx, signal) =>
      runWorkers(state, params as WorkersParams, signal),
    onSession: (event) => handleSession(state, event.reason),
  };
};

export default workersTool;
