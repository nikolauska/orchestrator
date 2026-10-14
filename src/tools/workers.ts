import type { ToolOutcome } from "../core/tool";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { targetKey, type ExecutionTarget, type HostPath } from "../runtime/execution";
import { canonicalPath, HostFailure } from "../runtime/host-paths";
import {
  adoptLegacyLocalRecord,
  createLocalHostRuntime,
  dispatchHostRequest,
  type HostRuntime,
} from "../runtime/host";
import {
  PROTOCOL,
  type HostArgs,
  type HostError,
  type HostRequest,
  type HostResult,
  type ResultOp,
  type AllocatedWorker,
  type MutationOp,
  type DeliveryReceipt,
  validateHostResult,
  hostArgsSchemas,
} from "../runtime/helper-protocol";
import { callHelper } from "../runtime/remote";
import { collectReport } from "../runtime/report-transfer";
import { listMachines, selectMachine, validateBinding, machineError } from "../runtime/machines";
import { prepareLaunchOperation, runLaunchOperation } from "./orchestrator_task";
import {
  closeWorkerSpace,
  listWorkspaces,
  agentBinding,
  createTab,
  getAgent,
  interruptAgent,
  promptAgent,
  readAgent,
  startAgent,
  waitForAgent,
  waitForShell,
  resolveLocalHerdrTarget,
  HerdrError,
  type HerdrAgent,
} from "../runtime/herdr";
import { projectSpace, researchSpace, workerLabel } from "../runtime/spaces";
import { WorkerStore, type SupervisorEvent } from "../runtime/store";
import {
  errorMessage,
  NAME,
  text,
  type RuntimeDeps,
  valueAt,
  stringAt,
  type ToolAPI,
  type ToolFactory,
  type WorkerRecord,
  type WorkersParams,
  type WorkerConnection,
} from "../runtime/shared";

export type WorkerState = {
  api: ToolAPI;
  deps: RuntimeDeps;
  root: string;
  env: Record<string, string | undefined>;
  neutralRoot: string;
  target?: ExecutionTarget;
  targetPromise?: Promise<ExecutionTarget>;
  records: Map<string, WorkerRecord>;
  store: WorkerStore;
  resuming?: Promise<void>;
  deliveryQueues: Map<string, Promise<void>>;
  active: boolean;
  /** Identifies this session in the store's owner row. */
  token: string;
  owner: boolean;
  /** Events handed to an asynchronous harness wake but not yet accepted. */
  delivering: Set<number>;
  localRuntime?: Promise<HostRuntime>;
  reconnect: Map<string, { attempts: number; nextAt: number }>;
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
const screenEpochs = new WeakMap<WorkerRecord, number>();

export function stateFor(pi: ToolAPI): WorkerState {
  const existing = states.get(pi);
  if (existing) return existing;

  const state: WorkerState = {
    api: pi,
    deps: pi,
    root: pi.cwd,
    env: pi.env ?? process.env,
    neutralRoot: pi.neutralRoot ?? join(homedir(), ".omp", "orchestrator", "independent-workers"),
    target: pi.target,
    records: new Map(),
    store: new WorkerStore(join(pi.cwd, ".omp", "orchestrator.db")),
    reconnect: new Map(),
    deliveryQueues: new Map(),
    active: true,
    token: crypto.randomUUID(),
    owner: false,
    delivering: new Set(),
  };
  states.set(pi, state);
  return state;
}

export async function herdrTarget(
  state: WorkerState,
  record?: WorkerRecord,
  signal?: AbortSignal,
): Promise<ExecutionTarget> {
  if (record) {
    if (!record.target || record.target.kind === "unresolved_local")
      throw new Error("Retained worker requires verification of its original local Herdr binding");
    return record.target;
  }
  if (state.target) return state.target;
  state.targetPromise ??= resolveLocalHerdrTarget(
    state.deps,
    { runtimeRoot: state.root, neutralRoot: state.neutralRoot, hostId: state.store.controllerId },
    signal,
  ).catch((error) => {
    state.targetPromise = undefined;
    throw error;
  });
  state.target = await state.targetPromise;
  return state.target;
}

export function isCurrent(state: WorkerState, record: WorkerRecord): boolean {
  return state.active && state.records.get(record.name) === record;
}

export function eventMessage(
  outcome: Record<string, unknown>,
  heading = "Visible worker result",
): string {
  return `${heading}:\n${JSON.stringify(outcome, null, 2)}`;
}

/** Records the event durably first, so a session that ends before delivery can still read it. */
export function notify(
  state: WorkerState,
  outcome: Record<string, unknown>,
  heading = "Visible worker result",
): void {
  const worker = typeof outcome.name === "string" ? outcome.name : undefined;
  let event: SupervisorEvent;
  try {
    event = state.store.recordEvent(worker, eventMessage(outcome, heading));
  } catch (error) {
    // Keep the wake: losing durability is better than losing the root's only notice.
    state.deps.logger.warn?.("Supervisor event could not be recorded", {
      error: errorMessage(error),
    });
    if (state.active)
      void Promise.resolve(state.deps.notify(eventMessage(outcome, heading))).catch(() => {});
    return;
  }
  deliver(state, event);
}

/** Pending events stay readable through `workers events` and are retried at the next session start. */
export function deliver(state: WorkerState, event: SupervisorEvent): void {
  if (!state.active || state.delivering.has(event.id)) return;
  const failed = (error: unknown) =>
    state.deps.logger.warn?.("Supervisor event delivery failed; it stays pending", {
      event: event.id,
      error: errorMessage(error),
    });
  let accepted: void | Promise<void>;
  try {
    accepted = state.deps.notify(event.message);
  } catch (error) {
    failed(error);
    return;
  }
  if (!(accepted instanceof Promise)) {
    state.store.markDelivered([event.id]);
    return;
  }
  state.delivering.add(event.id);
  accepted
    .then(() => state.store.markDelivered([event.id]), failed)
    .catch(failed)
    .finally(() => state.delivering.delete(event.id));
}

export function flushEvents(state: WorkerState): void {
  for (const event of state.store.pendingEvents()) deliver(state, event);
}

export function hasWorker(state: WorkerState, name: string): boolean {
  return state.records.has(name) || state.store.has(name);
}

export function publicRecord(record: WorkerRecord): Record<string, unknown> {
  return {
    kind: record.kind,
    ...(record.scope === "independent" ? { scope: "independent" } : { project: record.project }),
    name: record.name,
    ...(record.agent_kind ? { agent: record.agent_kind } : {}),
    ...(record.role ? { role: record.role } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    status: record.status,
    machine: record.target?.machineId ?? "local",
    ...(record.target && record.target.kind !== "unresolved_local"
      ? { session: record.target.session, os: record.target.os, host_id: record.target.hostId }
      : {}),
    phase: record.phase,
    connection: record.connection ?? unknownConnection(),
    status_changed_at: record.status_changed_at,
    last_herdr_contact: record.connection?.herdr.lastSuccessAt,
    last_helper_contact: record.connection?.helper.lastSuccessAt,
    cleanup_phase: record.cleanup_phase,
    report_source_path: record.report_source_path,
    report_receipt: record.report_receipt,
    delivery_receipt: record.delivery_receipt,
    terminal_outcome: record.terminal_outcome,
    cleanup_pending: !!record.terminal_outcome && record.cleanup_phase !== "complete",
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
  if (!state.owner) throw new Error("Worker persistence requires supervisor ownership");
  if (isCurrent(state, record)) {
    state.store.save(record);
  }
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
    `Another orchestrator session (pid ${owner?.pid}) has supervised these workers since ${owner?.claimed_at}; this session is read-only until that session exits`,
  );
}

export function adoptWorker(state: WorkerState, record: WorkerRecord, status: string): void {
  state.records.set(record.name, record);
  state.store.save(record);
  if (record.status === "starting") return;
  if (status === "working" || status === "blocked") {
    updateConnection(state, record, "herdr");
    updateConnection(state, record, "helper");
    observe(state, record, status, true);
  }
}

export function disposeWorkers(state: WorkerState): void {
  state.active = false;
  state.resuming = undefined;
  for (const record of state.records.values()) record.watch?.abort();
  state.reconnect.clear();
  // Durable rows stay: the next session resumes the same workers.
  state.records.clear();
  if (state.owner) state.store.release(state.token);
  state.owner = false;
}

/** Re-attaches workers recorded by an earlier OMP session; concurrent callers share one pass. */
export function resumeWorkers(state: WorkerState): Promise<void> {
  if (!state.owner) return Promise.resolve();
  state.resuming ??= Promise.all(
    state.store.all().map((record) => {
      const current = state.records.get(record.name);
      return current?.watch ? undefined : resumeWorker(state, current ?? record);
    }),
  ).then(() => undefined);
  return state.resuming;
}

export function handleSession(state: WorkerState, reason: string): void {
  if (reason === "switch" || reason === "shutdown") disposeWorkers(state);
  if (reason === "start" || reason === "switch") {
    state.active = true;
    // Resume without waiting for a tool call so finished workers still deliver and wake the root.
    if (claimOwnership(state)) {
      flushEvents(state);
      void resumeWorkers(state);
    }
  }
}

async function resumeWorker(state: WorkerState, record: WorkerRecord): Promise<void> {
  state.records.set(record.name, record);
  try {
    if (record.target?.kind === "unresolved_local") await adoptLocalWorker(state, record);
    if (record.status === "starting") await recoverWorker(state, record);
    if (record.terminal_outcome) {
      if (record.terminal_outcome.kind === "closed" || record.terminal_outcome.kind === "discarded")
        await closeWorker(state, record, record.terminal_outcome.kind === "discarded");
      else await finishWorker(state, record, settledOutcome(record, ""), true);
      return;
    }
    if (!isCurrent(state, record)) return;
    if (pendingSettlement(state, record)) {
      await settleWorker(state, record);
      return;
    }
    if (
      record.status === "failed" ||
      record.status === "interrupted" ||
      record.status === "ready" ||
      record.phase === "retained"
    )
      return;
    const agent = await verifyWorkerAgent(state, record);
    observe(state, record, agent.status, record.status !== "blocked");
  } catch (error) {
    if (!isCurrent(state, record)) return;
    observationFailure(state, record, error, "Worker could not be resumed");
    if (record.status !== "failed") watchWorker(state, record);
  }
}

function unknownConnection(): WorkerConnection {
  return { herdr: { state: "unknown" }, helper: { state: "unknown" }, state: "unknown" };
}

export function updateConnection(
  state: WorkerState,
  record: WorkerRecord,
  channel: "herdr" | "helper",
  error?: HostError,
): void {
  const connection = (record.connection ??= unknownConnection());
  const previous = connection[channel];
  if (channel === "herdr" && error) screenEpochs.set(record, (screenEpochs.get(record) ?? 0) + 1);
  connection[channel] = error
    ? {
        state: ["TRANSPORT_OFFLINE", "TIMEOUT"].includes(error.code) ? "offline" : "attention",
        ...(previous.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
        error: {
          code: error.code,
          message: error.message,
          channel: error.channel,
          effect: error.effect,
          retry: error.retry,
          ...(error.operationId ? { operationId: error.operationId } : {}),
          ...(error.remedy ? { remedy: error.remedy } : {}),
        },
      }
    : { state: "online", lastSuccessAt: new Date().toISOString() };
  const channels = [connection.herdr.state, connection.helper.state];
  connection.state = channels.includes("attention")
    ? "attention"
    : channels.includes("offline")
      ? "offline"
      : channels.includes("unknown")
        ? "unknown"
        : "online";
  if (state.owner && isCurrent(state, record)) persist(state, record);
}

async function localRuntime(state: WorkerState): Promise<HostRuntime> {
  return (
    state.api.localHostRuntime ??
    (state.localRuntime ??= createLocalHostRuntime(state.api, {
      cwd: state.root,
      neutralRoot: state.neutralRoot,
    }))
  );
}

async function validateStoredProfile(
  state: WorkerState,
  target: ExecutionTarget,
  signal?: AbortSignal,
): Promise<void> {
  if (target.kind !== "ssh") return;
  validateBinding(selectMachine(await listMachines(state.api, signal), target.machineId), target);
}

export async function workerHostCall<Op extends ResultOp>(
  state: WorkerState,
  record: WorkerRecord,
  op: Op,
  args: HostArgs[Op],
  options: { signal?: AbortSignal; operationId?: string } = {},
): Promise<HostResult<Op>> {
  try {
    const target = await herdrTarget(state, record, options.signal);
    await validateStoredProfile(state, target, options.signal);
    const request = {
      protocol: PROTOCOL,
      version: 1,
      requestId: crypto.randomUUID(),
      controllerId: record.controller_id!,
      expectedHostId: target.hostId,
      op,
      args,
      ...(options.operationId ? { operationId: options.operationId } : {}),
    } as HostRequest<Op>;
    let result: HostResult<Op>;
    if (target.kind === "local") {
      const reply = await dispatchHostRequest(await localRuntime(state), request);
      if (!reply.ok) throw new HostFailure(reply.error.code, reply.error.message, reply.error);
      result = reply.result;
    } else {
      const operationResults = Object.fromEntries(
        state.store
          .operations({ name: record.name, launchId: record.launch_id })
          .filter((entry) => entry.channel === "helper")
          .map((entry) => [entry.id, entry.operation as ResultOp]),
      );
      result = await callHelper(target, request, {
        spawnStdio: state.api.spawnStdio,
        signal: options.signal,
        operationResults,
      });
    }
    updateConnection(state, record, "helper");
    return result;
  } catch (error) {
    updateConnection(state, record, "helper", machineError(error, "helper"));
    throw error;
  }
}

export async function verifyWorkerAgent(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<HerdrAgent> {
  try {
    const target = await herdrTarget(state, record, signal);
    await validateStoredProfile(state, target, signal);
    const agent = await getAgent(state.deps, target, record.pane_id, { signal });
    const binding = record.agent_binding;
    if (!binding)
      throw new HerdrError("OPERATION_UNCERTAIN", "Worker has no verified agent binding");
    agentBinding(
      target,
      agent,
      binding.cwd,
      {
        name: record.agent_name!,
        paneId: record.pane_id!,
        tabId: record.tab_id!,
        workspaceId: record.workspace_id!,
      },
      binding.revision,
      binding.identity,
    );
    if (
      (binding.incarnation && binding.incarnation !== agent.incarnation) ||
      (binding.sessionPath && binding.sessionPath !== agent.sessionPath)
    )
      throw new HerdrError("AGENT_MISMATCH", "Worker terminal or agent session was replaced");
    updateConnection(state, record, "herdr");
    return agent;
  } catch (error) {
    updateConnection(state, record, "herdr", machineError(error, "herdr"));
    throw error;
  }
}

export async function verifyWorkerClosure(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await verifyWorkerAgent(state, record, signal);
    return true;
  } catch (error) {
    if (!(error instanceof HerdrError) || error.code !== "RESOURCE_NOT_FOUND") throw error;
  }
  const target = await herdrTarget(state, record, signal);
  const binding = record.agent_binding;
  if (!binding)
    throw new HerdrError("OPERATION_UNCERTAIN", "Closure requires the original terminal binding");
  try {
    await validateStoredProfile(state, target, signal);
    const route =
      target.kind === "ssh" ? ["--machine", target.machineId] : ["--session", target.session];
    const query = async (args: string[]) => {
      let result;
      try {
        result = await state.deps.exec("herdr", [...route, ...args], { signal, timeout: 10_000 });
      } catch {
        throw new HerdrError("TRANSPORT_OFFLINE", "Bound terminal topology is unavailable");
      }
      if (result.code || result.killed)
        throw new HerdrError(
          result.killed ? "TIMEOUT" : "TRANSPORT_OFFLINE",
          "Bound terminal topology is unavailable",
        );
      try {
        return JSON.parse(result.stdout) as unknown;
      } catch {
        throw new HerdrError("PROTOCOL_MISMATCH", "Bound terminal topology returned invalid JSON");
      }
    };
    const status = await query(["status", "server", "--json"]);
    const session = valueAt(status, ["session"]);
    if ((session === null ? "default" : session) !== target.session)
      throw new HerdrError("PROFILE_CHANGED", "Bound server session changed; closure refused");
    const value = await query(["api", "snapshot"]);
    const snapshot = valueAt(value, ["result", "snapshot"]);
    const arrays = ["panes", "tabs", "workspaces", "agents"].map((key) => valueAt(snapshot, [key]));
    if (arrays.some((items) => !Array.isArray(items)))
      throw new HerdrError(
        "CAPABILITY_MISSING",
        "Closure requires fresh pane, tab, space and agent topology",
      );
    const [panes, tabs, workspaces, agents] = arrays as unknown[][];
    const resourcePresent =
      record.scope === "project"
        ? workspaces!.some((item) => stringAt(item, ["workspace_id"]) === binding.workspaceId)
        : tabs!.some((item) => stringAt(item, ["tab_id"]) === binding.tabId);
    if (!resourcePresent) {
      updateConnection(state, record, "herdr");
      return false;
    }
    const pane = panes!.find((item) => stringAt(item, ["pane_id"]) === binding.paneId);
    if (
      !pane ||
      !binding.incarnation ||
      stringAt(pane, ["terminal_id"]) !== binding.incarnation ||
      stringAt(pane, ["cwd"]) !== binding.cwd.path ||
      stringAt(pane, ["tab_id"]) !== binding.tabId ||
      stringAt(pane, ["workspace_id"]) !== binding.workspaceId ||
      agents!.some((item) => stringAt(item, ["pane_id"]) === binding.paneId) ||
      (stringAt(pane, ["agent"]) && stringAt(pane, ["agent"]) !== "none")
    )
      throw new HerdrError(
        "AGENT_MISMATCH",
        "Dead agent's retained terminal cannot be proven; closure refused",
      );
    const sessionPath = stringAt(pane, ["agent_session", "value"]);
    if (sessionPath && binding.sessionPath && sessionPath !== binding.sessionPath)
      throw new HerdrError("AGENT_MISMATCH", "Dead terminal holds a replacement agent session");
    updateConnection(state, record, "herdr");
    return true;
  } catch (error) {
    updateConnection(state, record, "herdr", machineError(error, "herdr"));
    throw error;
  }
}

async function legacyScoutSpacePresent(
  state: WorkerState,
  record: WorkerRecord,
  target: ExecutionTarget,
  directory: HostPath,
  snapshot?: unknown,
): Promise<boolean> {
  if (snapshot === undefined) {
    const result = await state.deps.exec("herdr", ["--session", target.session, "api", "snapshot"]);
    if (result.code || result.killed)
      throw new HerdrError("TRANSPORT_OFFLINE", "Legacy terminal evidence is unavailable");
    snapshot = valueAt(JSON.parse(result.stdout), ["result", "snapshot"]);
  }
  const topology = ["panes", "tabs", "workspaces", "agents"].map((key) => valueAt(snapshot, [key]));
  if (topology.some((items) => !Array.isArray(items)))
    throw new HerdrError(
      "CAPABILITY_MISSING",
      "Legacy close requires complete fresh terminal topology",
    );
  const [panes, tabs, workspaces, agents] = topology as unknown[][];
  const matches = (item: unknown) =>
    stringAt(item, ["pane_id"]) === record.pane_id ||
    stringAt(item, ["tab_id"]) === record.tab_id ||
    stringAt(item, ["workspace_id"]) === record.workspace_id ||
    stringAt(item, ["cwd"]) === directory.path ||
    stringAt(item, ["name"]) === (record.agent_name ?? record.name) ||
    stringAt(item, ["agent_name"]) === (record.agent_name ?? record.name);
  if (agents!.some(matches))
    throw new HerdrError(
      "AGENT_MISMATCH",
      "Legacy worker topology contains a live or replacement agent",
    );
  const present = workspaces!.some(
    (item) => stringAt(item, ["workspace_id"]) === record.workspace_id,
  );
  if (!present) {
    if ([...panes!, ...tabs!].some(matches))
      throw new HerdrError("AGENT_MISMATCH", "Legacy terminal moved outside its original space");
    return false;
  }
  const space = (await listWorkspaces(state.deps, target)).find(
    (item) => item.workspaceId === record.workspace_id,
  );
  if (
    !space?.linked ||
    !space.checkoutPath ||
    !space.repoRoot ||
    (await canonicalPath(space.checkoutPath)).pathKey !== directory.pathKey ||
    (await canonicalPath(space.repoRoot)).pathKey !==
      (await canonicalPath(record.projectPath!)).pathKey
  )
    throw new HerdrError(
      "AGENT_MISMATCH",
      "Legacy space no longer belongs to the retained project lease",
    );
  const unsafePane = panes!.some(
    (item) =>
      matches(item) &&
      (stringAt(item, ["pane_id"]) !== record.pane_id ||
        stringAt(item, ["tab_id"]) !== record.tab_id ||
        stringAt(item, ["workspace_id"]) !== record.workspace_id ||
        stringAt(item, ["cwd"]) !== directory.path ||
        (!!stringAt(item, ["agent"]) && stringAt(item, ["agent"]) !== "none")),
  );
  const unsafeTab = tabs!.some(
    (item) =>
      stringAt(item, ["workspace_id"]) === record.workspace_id &&
      stringAt(item, ["tab_id"]) !== record.tab_id,
  );
  if (unsafePane || unsafeTab)
    throw new HerdrError(
      "AGENT_MISMATCH",
      "Legacy space contains a replacement terminal; retained",
    );
  return true;
}

async function adoptLocalWorker(
  state: WorkerState,
  record: WorkerRecord,
  closing = false,
): Promise<void> {
  const runtime = await localRuntime(state);
  const target = await resolveLocalHerdrTarget(state.deps, {
    hostId: runtime.configuration.hostId,
    runtimeRoot: runtime.configuration.runtimeRoot,
    neutralRoot: runtime.configuration.neutralRoot,
  });
  const directory = await canonicalPath(record.worktree ?? record.working_directory ?? "");
  let binding: NonNullable<WorkerRecord["agent_binding"]>;
  try {
    const agent = await getAgent(state.deps, target, record.pane_id);
    // Failed unbound legacy records cannot distinguish the original live agent from a recycled alias.
    if (record.status === "failed" && !record.agent_binding)
      throw new HerdrError(
        "AGENT_MISMATCH",
        "Failed legacy worker has no original live-agent binding; retained",
      );
    binding = agentBinding(
      target,
      agent,
      directory,
      {
        name: record.agent_name ?? record.name,
        paneId: record.pane_id!,
        tabId: record.tab_id!,
        workspaceId: record.workspace_id!,
      },
      1,
    );
  } catch (error) {
    if (!(error instanceof HerdrError) || error.code !== "RESOURCE_NOT_FOUND") throw error;
    // Old records have no incarnation. Only fresh matching dead-terminal evidence can establish it.
    const result = await state.deps.exec("herdr", ["--session", target.session, "api", "snapshot"]);
    if (result.code || result.killed)
      throw new HerdrError("TRANSPORT_OFFLINE", "Legacy terminal evidence is unavailable");
    const snapshot = valueAt(JSON.parse(result.stdout), ["result", "snapshot"]);
    const panes = valueAt(snapshot, ["panes"]);
    if (
      closing &&
      record.scope === "project" &&
      record.kind === "scout" &&
      record.status === "failed"
    ) {
      const present = await legacyScoutSpacePresent(state, record, target, directory, snapshot);
      // Explicit close owns only this lease's empty topology, never a fabricated live-agent binding.
      const resource = await adoptLegacyLocalRecord(runtime, record, target, {
        closureOnly: true,
        session: target.session,
      });
      const previous = state.store
        .operations({ name: record.name, launchId: record.launch_id })
        .findLast((entry) => entry.operation === "worker.close" && entry.state !== "refused");
      if (present) {
        if (previous && previous.state !== "prepared")
          throw new HerdrError(
            "OPERATION_UNCERTAIN",
            "Legacy space close is unresolved; retained without replay",
          );
        const intent =
          previous ??
          prepareLaunchOperation(state, record, "herdr", "worker.close", {
            target,
            workspaceId: record.workspace_id,
            directory,
            lease: resource.scope === "project" ? resource.lease : undefined,
          });
        try {
          await runLaunchOperation(state, intent, () =>
            closeWorkerSpace(state.deps, target, record),
          );
        } catch (error) {
          if (await legacyScoutSpacePresent(state, record, target, directory)) throw error;
          intent.state = "confirmed";
          intent.response = { closed: true };
          intent.updatedAt = new Date().toISOString();
          state.store.saveOperation(intent);
        }
      } else if (previous && previous.state !== "confirmed") {
        previous.state = "confirmed";
        previous.response = { closed: true };
        previous.updatedAt = new Date().toISOString();
        state.store.saveOperation(previous);
      }
      record.target = target;
      record.project_path_key = resource.scope === "project" ? resource.project.pathKey : undefined;
      record.report_source_path = resource.reportSourcePath;
      record.cleanup_phase = "space_closed";
      updateConnection(state, record, "helper");
      updateConnection(state, record, "herdr");
      persist(state, record);
      return;
    }
    const pane = Array.isArray(panes)
      ? panes.find((item) => stringAt(item, ["pane_id"]) === record.pane_id)
      : undefined;
    if (
      !pane ||
      stringAt(pane, ["cwd"]) !== directory.path ||
      stringAt(pane, ["workspace_id"]) !== record.workspace_id ||
      stringAt(pane, ["tab_id"]) !== record.tab_id ||
      !stringAt(pane, ["terminal_id"]) ||
      (stringAt(pane, ["agent"]) && stringAt(pane, ["agent"]) !== "none")
    )
      throw new HerdrError("AGENT_MISMATCH", "Legacy dead terminal cannot be proven; retained");
    binding = {
      revision: 1,
      identity: "omp",
      agentName: record.agent_name ?? record.name,
      session: target.session,
      cwd: directory,
      workspaceId: record.workspace_id!,
      tabId: record.tab_id!,
      paneId: record.pane_id!,
      incarnation: stringAt(pane, ["terminal_id"]),
    };
    const previous = record.target;
    record.target = target;
    record.agent_binding = binding;
    try {
      await verifyWorkerClosure(state, record);
    } catch (error) {
      record.target = previous;
      record.agent_binding = undefined;
      throw error;
    }
    record.target = previous;
    record.agent_binding = undefined;
  }
  const resource = await adoptLegacyLocalRecord(runtime, record, target, binding);
  record.target = target;
  record.agent_binding = binding;
  if (resource.scope === "project") record.project_path_key = resource.project.pathKey;
  record.report_source_path = resource.reportSourcePath;
  updateConnection(state, record, "helper");
  updateConnection(state, record, "herdr");
}

function restoreResource(record: WorkerRecord, resource: AllocatedWorker): void {
  if (resource.launchId !== record.launch_id || resource.scope !== record.scope)
    throw new HostFailure("LEASE_MISMATCH", "Lookup returned a different worker allocation");
  const directory = record.worktree ?? record.working_directory;
  if (directory && directory !== resource.directory.path)
    throw new HostFailure("LEASE_MISMATCH", "Lookup changed the retained worker directory");
  if (resource.scope === "project") {
    if (
      (record.lease_id && record.lease_id !== resource.lease.leaseId) ||
      (record.lease_holder && record.lease_holder !== resource.lease.leaseHolder)
    )
      throw new HostFailure("LEASE_MISMATCH", "Lookup changed the retained lease");
    record.worktree = resource.directory.path;
    record.lease_id = resource.lease.leaseId;
    record.lease_holder = resource.lease.leaseHolder;
    record.project_path_key ??= resource.project.pathKey;
  } else record.working_directory = resource.directory.path;
  record.report_source_path ??= resource.reportSourcePath;
}

function bindingOperations(state: WorkerState, record: WorkerRecord) {
  const operations = state.store.operations({ name: record.name, launchId: record.launch_id });
  const boundary = operations.findLastIndex((entry) => entry.operation === "worker.relaunch");
  return operations.slice(Math.max(0, boundary));
}

function checkpoint(
  state: WorkerState,
  record: WorkerRecord,
  operation: string,
  response: unknown,
): void {
  const intent = prepareLaunchOperation(state, record, "controller", operation, response);
  intent.state = "confirmed";
  intent.response = response;
  state.store.saveOperation(intent);
}

function promptCompleted(state: WorkerState, record: WorkerRecord, agent: HerdrAgent): boolean {
  const baseline = bindingOperations(state, record).findLast(
    (entry) => entry.operation === "prompt.baseline",
  );
  const sequence = baseline
    ? valueAt(baseline.response, ["completionSeq"])
    : record.agent_binding?.completionSeq;
  return (
    typeof sequence === "number" &&
    agent.completionSeq !== undefined &&
    agent.completionSeq > sequence
  );
}

export async function recoverWorker(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
  submitPrompt = true,
): Promise<void> {
  const lookup = await workerHostCall(
    state,
    record,
    "worker.lookup",
    { launchId: record.launch_id! },
    { signal },
  );
  if (lookup.resource) restoreResource(record, lookup.resource);
  for (const intent of state.store.operations({ name: record.name, launchId: record.launch_id })) {
    if (intent.channel !== "helper" || intent.state === "confirmed" || intent.state === "refused")
      continue;
    let view;
    try {
      view = await workerHostCall(
        state,
        record,
        "operation.get",
        { operationId: intent.id },
        { signal },
      );
    } catch (error) {
      if (
        !(error instanceof HostFailure) ||
        error.detail.code !== "OPERATION_NOT_STARTED" ||
        error.detail.effect !== "none"
      )
        throw error;
      intent.state = "refused";
      intent.error = error.detail;
      intent.updatedAt = new Date().toISOString();
      state.store.saveOperation(intent);
      continue;
    }
    // Controller intents hash arguments; helper receipts hash the entire wire identity.
    if (view.operationId !== intent.id)
      throw new HostFailure("PROTOCOL_MISMATCH", "Operation lookup returned another operation");
    intent.state = view.state === "running" ? "sent" : view.state;
    intent.response = view.result;
    intent.error = view.error;
    intent.updatedAt = new Date().toISOString();
    state.store.saveOperation(intent);
  }
  const target = await herdrTarget(state, record, signal);
  await validateStoredProfile(state, target, signal);
  const operations = bindingOperations(state, record);
  const relaunch = operations.find((entry) => entry.operation === "worker.relaunch");
  const revision = relaunch ? (valueAt(relaunch.response, ["revision"]) as number) : 1;
  const open = operations.findLast((entry) => entry.operation === "worker.open");
  if (relaunch && open && ["sent", "uncertain"].includes(open.state)) {
    if (!lookup.resource)
      throw new HostFailure("LEASE_MISMATCH", "Relaunch allocation is no longer owned");
    const route =
      target.kind === "ssh" ? ["--machine", target.machineId] : ["--session", target.session];
    const result = await state.deps.exec("herdr", [...route, "api", "snapshot"], {
      signal,
      timeout: 10_000,
    });
    if (result.code || result.killed)
      throw new HerdrError(
        result.killed ? "TIMEOUT" : "TRANSPORT_OFFLINE",
        "Relaunch topology is unavailable",
      );
    let snapshot: unknown;
    try {
      snapshot = valueAt(JSON.parse(result.stdout), ["result", "snapshot"]);
    } catch {
      throw new HerdrError("PROTOCOL_MISMATCH", "Relaunch topology is invalid");
    }
    const panes = valueAt(snapshot, ["panes"]);
    if (!Array.isArray(panes))
      throw new HerdrError("CAPABILITY_MISSING", "Relaunch requires pane topology");
    const matches = panes.filter(
      (pane) => stringAt(pane, ["cwd"]) === lookup.resource!.directory.path,
    );
    if (matches.length !== 1)
      throw new HerdrError(
        "OPERATION_UNCERTAIN",
        "Replacement terminal is not uniquely identified",
        "unknown",
        "reconcile",
      );
    const pane = matches[0];
    const paneId = stringAt(pane, ["pane_id"]);
    const tabId = stringAt(pane, ["tab_id"]);
    const workspaceId = stringAt(pane, ["workspace_id"]);
    const incarnation = stringAt(pane, ["terminal_id"]);
    if (!paneId || !tabId || !workspaceId || !incarnation)
      throw new HerdrError(
        "OPERATION_UNCERTAIN",
        "Replacement terminal identity is incomplete",
        "unknown",
        "reconcile",
      );
    if (
      (stringAt(pane, ["name"]) && stringAt(pane, ["name"]) !== record.agent_name) ||
      (stringAt(pane, ["agent"]) && stringAt(pane, ["agent"]) !== "none")
    )
      throw new HerdrError("AGENT_MISMATCH", "Replacement terminal belongs to another agent");
    open.state = "confirmed";
    open.response = { paneId, tabId, workspaceId };
    open.updatedAt = new Date().toISOString();
    state.store.saveOperation(open);
  }
  for (const operation of operations) {
    if (operation.operation !== "worker.open" || operation.state !== "confirmed") continue;
    const space = operation.response as
      | { workspaceId?: string; tabId?: string; paneId?: string }
      | undefined;
    if (space && (!record.pane_id || relaunch)) {
      record.workspace_id = space.workspaceId;
      record.tab_id = space.tabId;
      record.pane_id = space.paneId;
    }
  }
  let start = operations.findLast((entry) => entry.operation === "agent.start");
  if (relaunch && !start && open?.state === "confirmed") {
    const directory = lookup.resource!.directory.path;
    const choice = { model: record.model, thinking: record.thinking };
    record.phase = "starting_agent";
    persist(state, record);
    await waitForShell(state.deps, target, record.pane_id!, { signal });
    start = prepareLaunchOperation(state, record, "herdr", "agent.start", {
      target,
      directory,
      choice,
      alias: record.agent_name,
    });
    await runLaunchOperation(state, start, () =>
      startAgent(
        state.deps,
        target,
        record.agent_kind ?? "omp",
        record.agent_name!,
        record.pane_id!,
        directory,
        choice,
        { signal },
      ),
    );
  }
  if (!start) {
    persist(state, record);
    return;
  }
  let agent: HerdrAgent;
  try {
    agent = await getAgent(state.deps, target, record.pane_id ?? record.agent_name, { signal });
  } catch (error) {
    if (
      relaunch &&
      ["sent", "uncertain"].includes(start.state) &&
      error instanceof HerdrError &&
      error.code === "RESOURCE_NOT_FOUND"
    )
      throw new HerdrError(
        "OPERATION_UNCERTAIN",
        "Replacement agent start is unresolved; retain its terminal",
        "unknown",
        "reconcile",
      );
    throw error;
  }
  if (!record.pane_id && agent.paneId && agent.tabId && agent.workspaceId) {
    record.pane_id = agent.paneId;
    record.tab_id = agent.tabId;
    record.workspace_id = agent.workspaceId;
  }
  const directory = lookup.resource?.directory ?? record.agent_binding?.cwd;
  if (!directory)
    throw new HostFailure("OPERATION_UNCERTAIN", "Allocation ownership is not yet proven", {
      retry: "reconcile",
    });
  const binding =
    record.agent_binding && record.agent_binding.revision >= revision
      ? record.agent_binding
      : agentBinding(
          target,
          { ...agent, sessionPath: undefined },
          directory,
          {
            name: record.agent_name!,
            paneId: record.pane_id!,
            tabId: record.tab_id!,
            workspaceId: record.workspace_id!,
          },
          revision,
          record.agent_kind ?? "omp",
        );
  if (lookup.binding && lookup.binding.revision >= binding.revision) {
    const original = binding;
    if (
      lookup.binding.agentName !== original.agentName ||
      lookup.binding.paneId !== original.paneId ||
      lookup.binding.session !== original.session ||
      lookup.binding.cwd.pathKey !== original.cwd.pathKey
    )
      throw new HostFailure("AGENT_MISMATCH", "Helper binding belongs to a different terminal");
    record.agent_binding = lookup.binding;
    await verifyWorkerAgent(state, record, signal);
  }
  if (!lookup.binding || lookup.binding.revision < binding.revision) {
    if (
      operations.some(
        (entry) =>
          entry.operation === "worker.bind-agent" &&
          ["prepared", "sent", "uncertain"].includes(entry.state),
      )
    ) {
      persist(state, record);
      return;
    }
    await bindWorkerAgent(state, record, binding, signal);
  }
  await verifyWorkerAgent(state, record, signal);
  let prompt = operations.findLast((entry) => entry.operation === "agent.prompt");
  if (relaunch && !prompt && submitPrompt) {
    const text = `${record.prompt}\n\n${RELAUNCH_NOTE}\nNote from the orchestrator: ${stringAt(relaunch.response, ["note"])}`;
    record.phase = "submitting_prompt";
    persist(state, record);
    checkpoint(state, record, "prompt.baseline", { completionSeq: agent.completionSeq });
    prompt = prepareLaunchOperation(state, record, "herdr", "agent.prompt", {
      target,
      binding: record.agent_binding,
      prompt: text,
    });
    await runLaunchOperation(state, prompt, () =>
      promptAgent(state.deps, target, record.pane_id, text, {
        signal,
        kind: record.agent_kind ?? "omp",
      }),
    );
    agent = await verifyWorkerAgent(state, record, signal);
  }
  const completed = prompt && promptCompleted(state, record, agent);
  if (prompt && (agent.status === "working" || agent.status === "blocked" || completed)) {
    record.phase = "running";
    setStatus(state, record, agent.status === "blocked" ? "blocked" : "working");
  }
  persist(state, record);
}

export async function bindWorkerAgent(
  state: WorkerState,
  record: WorkerRecord,
  binding: NonNullable<WorkerRecord["agent_binding"]>,
  signal?: AbortSignal,
): Promise<void> {
  const args = { launchId: record.launch_id!, binding };
  const intent = prepareLaunchOperation(state, record, "helper", "worker.bind-agent", args);
  await runLaunchOperation(state, intent, (operationId) =>
    workerHostCall(state, record, "worker.bind-agent", args, { signal, operationId }),
  );
  record.agent_binding = binding;
  persist(state, record);
}

function observationFailure(
  state: WorkerState,
  record: WorkerRecord,
  error: unknown,
  heading = "Worker observation failed",
): void {
  const detail = machineError(error, "herdr");
  updateConnection(state, record, detail.channel === "helper" ? "helper" : "herdr", detail);
  // Only a typed response from the bound server or verified foreign identity proves loss.
  if (
    detail.channel === "herdr" &&
    (detail.code === "RESOURCE_NOT_FOUND" || detail.code === "AGENT_MISMATCH")
  ) {
    record.error = `${heading}: ${detail.message}`;
    record.phase = "retained";
    record.watch?.abort();
    setStatus(state, record, "failed");
    notify(state, terminal(record, "failed", "", { error: record.error }));
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const finish = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal.addEventListener("abort", finish, { once: true });
  return promise;
}

function reconnectDelay(state: WorkerState, record: WorkerRecord, channel = "herdr"): number {
  const target = record.target;
  const key = `${target && target.kind !== "unresolved_local" ? targetKey(target) : "legacy-local"}:${channel}`;
  const now = Date.now();
  const previous = state.reconnect.get(key);
  if (previous && previous.nextAt > now) return previous.nextAt - now;
  const attempts = (previous?.attempts ?? 0) + 1;
  const ms = [1000, 2000, 5000, 10000, 30000, 60000][Math.min(attempts - 1, 5)]!;
  state.reconnect.set(key, { attempts, nextAt: now + ms });
  return ms;
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
    record.phase = "running";
    setStatus(state, record, "working");
    watchWorker(state, record);
  } else if (status === "idle" || status === "done") {
    if (record.status !== "starting") void settleWorker(state, record);
    else watchWorker(state, record);
  } else if (status === "blocked") {
    record.phase = "running";
    setStatus(state, record, "blocked");
    if (announce) void announceBlocked(state, record);
    // Keep watching so an answer typed directly in the worker's tab still leads to delivery.
    watchWorker(state, record);
  } else throw new Error(`Unexpected Herdr agent status: ${status}`);
}

// Connectivity writes advance updated_at, never the lifecycle clock.
function setStatus(state: WorkerState, record: WorkerRecord, status: WorkerRecord["status"]): void {
  if (record.status === status) return;
  record.status = status;
  persist(state, record);
}

export type WorkerScreen = {
  screen?: string;
  screen_error?: HostError;
  observed_at?: string;
};

export async function screenOf(
  state: WorkerState,
  record: WorkerRecord,
  lines: number,
  signal?: AbortSignal,
): Promise<WorkerScreen> {
  try {
    await verifyWorkerAgent(state, record, signal);
    const screen = await readAgent(
      state.deps,
      await herdrTarget(state, record, signal),
      record.pane_id,
      lines,
      { signal },
    );
    updateConnection(state, record, "herdr");
    return { screen, observed_at: new Date().toISOString() };
  } catch (error) {
    const detail = machineError(error, "herdr");
    updateConnection(state, record, "herdr", detail);
    return { screen_error: record.connection!.herdr.error! };
  }
}

async function announceBlocked(state: WorkerState, record: WorkerRecord): Promise<void> {
  const screen = await screenOf(state, record, SCREEN_LINES);
  if (isCurrent(state, record) && record.status === "blocked")
    notify(state, terminal(record, "blocked", screen.screen ?? "", screen));
}

export async function runWorkers(
  state: WorkerState,
  params: WorkersParams,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
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
        .filter((record) => !params.machine || record.target?.machineId === params.machine)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(publicRecord);
      const heading = owner
        ? "Visible workers"
        : `Visible workers (read-only; orchestrator session pid ${state.store.owner()?.pid} supervises them)`;
      return text(`${heading}:\n${JSON.stringify(records, null, 2)}`, records);
    }
    if (params.op === "events") {
      const events = params.all ? state.store.recentEvents() : state.store.pendingEvents();
      // Only the supervising session consumes events; another session's look must not steal them.
      if (owner) state.store.markDelivered(events.filter((e) => !e.deliveredAt).map((e) => e.id));
      const heading = params.all ? "Recent supervisor events" : "Pending supervisor events";
      return text(`${heading}:\n${JSON.stringify(events, null, 2)}`, events);
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
        records.map(async (record) => {
          const screen = await screenOf(state, record, lines, signal);
          return {
            name: record.name,
            status: record.status,
            machine: record.target?.machineId ?? "local",
            session:
              record.target?.kind !== "unresolved_local" ? record.target?.session : undefined,
            connection: record.connection ?? unknownConnection(),
            ...screen,
          };
        }),
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
    if (
      record.status === "starting" &&
      bindingOperations(state, record).some((entry) => entry.operation === "worker.relaunch")
    ) {
      record.generation++;
      record.watch?.abort();
      await recoverWorker(state, record, signal, false);
    }
    if (
      record.target?.kind !== "unresolved_local" &&
      record.launch_id &&
      !record.pane_id &&
      !record.agent_binding &&
      !state.store
        .operations({ name: record.name, launchId: record.launch_id })
        .some((intent) => intent.channel === "herdr" && intent.state !== "refused")
    ) {
      const lookup = await workerHostCall(
        state,
        record,
        "worker.lookup",
        { launchId: record.launch_id },
        { signal },
      );
      if (lookup.resource) {
        restoreResource(record, lookup.resource);
        record.cleanup_phase = "space_closed";
        persist(state, record);
      }
      if (!lookup.resource && lookup.operations.length === 0) {
        // Retire missing intents under the host lock, fencing any delayed allocation before removing the name.
        await recoverWorker(state, record, signal);
        if (
          state.store
            .operations({ name: record.name, launchId: record.launch_id })
            .every((intent) => intent.state === "refused")
        ) {
          record.generation++;
          record.watch?.abort();
          state.store.delete(record.name);
          state.records.delete(record.name);
          return { ...publicRecord(record), close: "closed", cleanup_pending: false };
        }
      }
    }
    if (record.target?.kind === "unresolved_local") await adoptLocalWorker(state, record, true);
    if (
      record.terminal_outcome &&
      (!["closed", "discarded"].includes(record.terminal_outcome.kind) ||
        ["releasing_directory", "directory_released", "complete"].includes(
          record.cleanup_phase ?? "",
        ))
    ) {
      const outcome = await finishWorker(state, record, settledOutcome(record, ""), false);
      return { ...outcome, close: isCurrent(state, record) ? "retained" : "closed" };
    }
    discard ||= record.terminal_outcome?.kind === "discarded";
    if (record.cleanup_phase !== "space_closed") await verifyWorkerClosure(state, record, signal);
    await workerHostCall(
      state,
      record,
      "worker.inspect",
      { launchId: record.launch_id! },
      { signal },
    );
    if (!discard) {
      const unlanded = await unlandedWork(state, record, signal);
      if (unlanded)
        return {
          ...publicRecord(record),
          close: "refused",
          reason: `${unlanded}; pass discard: true to close anyway`,
        };
    }
    record.generation++;
    record.watch?.abort();
    await closeTopology(state, record, signal);
    if (!discard) {
      const unlanded = await unlandedWork(state, record, signal);
      if (unlanded) throw new Error(`Space closed but checkout retained: ${unlanded}`);
    }
    record.terminal_outcome = {
      kind: discard ? "discarded" : "closed",
      authorizedAt: new Date().toISOString(),
    };
    persist(state, record);
    if (record.kind === "scout" && !(await absentLocalArchive(record))) {
      try {
        await completeScout(state, record, "");
      } catch (error) {
        // Discard permits abandoning invalid staging, never ignoring an archive collision or offline host.
        if (
          !discard ||
          !(error instanceof HostFailure) ||
          !["REPORT_INVALID", "REPORT_CHANGED", "RESOURCE_NOT_FOUND", "PATH_FORBIDDEN"].includes(
            error.detail.code,
          )
        )
          throw error;
      }
    }
    const outcome = await finishWorker(
      state,
      record,
      { ...publicRecord(record), close: "closed" },
      false,
    );
    return { ...outcome, close: isCurrent(state, record) ? "retained" : "closed" };
  } catch (error) {
    record.phase = "retained";
    record.error = errorMessage(error);
    persist(state, record);
    return { ...publicRecord(record), close: "retained", reason: record.error };
  }
}

async function absentLocalArchive(record: WorkerRecord): Promise<boolean> {
  if (
    record.target?.kind !== "local" ||
    !record.report_path ||
    record.report_source_path !== record.report_path
  )
    return false;
  try {
    await lstat(record.report_path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function unlandedWork(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<string> {
  if (record.kind !== "implementation") return "";
  const evidence = await workerHostCall(
    state,
    record,
    "worker.inspect",
    { launchId: record.launch_id! },
    { signal },
  );
  const delivered =
    evidence.head === record.delivery_base ||
    evidence.workerIsDelivered ||
    (record.delivery_receipt && evidence.head === record.delivery_receipt.workerHead);
  return [
    evidence.dirty ? `uncommitted changes in ${evidence.directory.path}` : "",
    !delivered
      ? `undelivered commits (HEAD ${evidence.head}, delivery base ${record.delivery_base})`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
}

async function settlementMutation<Op extends MutationOp>(
  state: WorkerState,
  record: WorkerRecord,
  op: Op,
  request: HostArgs[Op] | (() => Promise<HostArgs[Op]>),
  signal?: AbortSignal,
): Promise<HostResult<Op>> {
  let intent = state.store
    .operations({ name: record.name, launchId: record.launch_id })
    .findLast((entry) => entry.operation === op && entry.state !== "refused");
  if (intent?.state === "confirmed") return validateHostResult(op, intent.response);
  if (intent && intent.state !== "prepared") {
    let view;
    try {
      view =
        op === "delivery.land" || op === "delivery.push"
          ? (
              await workerHostCall(
                state,
                record,
                "delivery.lookup",
                { launchId: record.launch_id!, operationId: intent.id },
                { signal },
              )
            ).operation
          : await workerHostCall(
              state,
              record,
              "operation.get",
              { operationId: intent.id },
              { signal },
            );
    } catch (error) {
      if (
        !(error instanceof HostFailure) ||
        error.detail.code !== "OPERATION_NOT_STARTED" ||
        error.detail.effect !== "none"
      )
        throw error;
      intent.state = "refused";
      intent.error = error.detail;
      intent.updatedAt = new Date().toISOString();
      state.store.saveOperation(intent);
      return settlementMutation(state, record, op, request, signal);
    }
    intent.state =
      view.state === "running" ? "sent" : view.state === "prepared" ? "uncertain" : view.state;
    intent.response = view.result ?? intent.response;
    intent.error = view.error;
    intent.updatedAt = new Date().toISOString();
    state.store.saveOperation(intent);
    if (view.checkpoint?.deliveryBase && view.checkpoint.rebasedHead) {
      record.delivery_base = view.checkpoint.deliveryBase;
      persist(state, record);
    }
    if (view.state === "confirmed") return validateHostResult(op, view.result);
    throw new HostFailure(
      view.error?.code ?? "OPERATION_UNCERTAIN",
      view.error?.message ?? `${op} acknowledgement is unresolved; resources retained`,
      {
        effect: view.state === "refused" ? (view.error?.effect ?? "none") : "unknown",
        retry: view.state === "refused" ? (view.error?.retry ?? "user_action") : "reconcile",
        operationId: intent.id,
      },
    );
  }
  let args = typeof request === "function" ? await request() : request;
  if (!intent) {
    intent = prepareLaunchOperation(state, record, "helper", op, args);
    // Capture the approved SHA/ref before send, including a crash before the sent checkpoint.
    intent.response = { args };
    state.store.saveOperation(intent);
  } else {
    args = hostArgsSchemas[op].parse(valueAt(intent.response, ["args"])) as HostArgs[Op];
  }
  try {
    return await runLaunchOperation(state, intent, (id) =>
      workerHostCall(state, record, op, args, { signal, operationId: id }),
    );
  } catch (error) {
    if (op === "delivery.land" || op === "delivery.push") {
      const lookup = await workerHostCall(state, record, "delivery.lookup", {
        launchId: record.launch_id!,
        operationId: intent.id,
      }).catch(() => undefined);
      if (lookup?.operation.checkpoint?.rebasedHead && lookup.operation.checkpoint.deliveryBase) {
        record.delivery_base = lookup.operation.checkpoint.deliveryBase;
        persist(state, record);
      }
    }
    if (state.store.operation(intent.id)?.state === "uncertain")
      return settlementMutation(state, record, op, request, signal);
    throw error;
  }
}

async function closeTopology(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<void> {
  if (
    ["space_closed", "releasing_directory", "directory_released", "complete"].includes(
      record.cleanup_phase ?? "",
    )
  )
    return;
  const present = await verifyWorkerClosure(state, record, signal);
  const previous = bindingOperations(state, record).findLast(
    (entry) => entry.operation === "worker.close" && entry.state !== "refused",
  );
  if (present && previous?.state === "confirmed")
    throw new HerdrError(
      "AGENT_MISMATCH",
      "Closed topology is present again; do not close a replacement",
    );
  if (previous && previous.state !== "confirmed" && previous.state !== "prepared" && present)
    throw new HerdrError(
      "OPERATION_UNCERTAIN",
      "Space close acknowledgement is unresolved; retained without replay",
      "unknown",
      "reconcile",
    );
  record.cleanup_phase = "closing_space";
  persist(state, record);
  if (present && (!previous || previous.state === "prepared")) {
    const intent =
      previous ??
      prepareLaunchOperation(state, record, "herdr", "worker.close", {
        binding: record.agent_binding,
      });
    try {
      await runLaunchOperation(state, intent, () =>
        closeWorkerSpace(state.deps, record.target as ExecutionTarget, record, { signal }),
      );
    } catch (error) {
      if (await verifyWorkerClosure(state, record, signal)) throw error;
      intent.state = "confirmed";
      intent.response = { closed: true };
      intent.updatedAt = new Date().toISOString();
      state.store.saveOperation(intent);
    }
  } else if (previous && !present && previous.state !== "confirmed") {
    previous.state = "confirmed";
    previous.response = { closed: true };
    previous.updatedAt = new Date().toISOString();
    state.store.saveOperation(previous);
  }
  record.cleanup_phase = "space_closed";
  persist(state, record);
}

async function releaseWorker(
  state: WorkerState,
  record: WorkerRecord,
): Promise<HostResult<"worker.release">> {
  const outcome = record.terminal_outcome!;
  const proof =
    outcome.kind === "discarded" ? "discard" : outcome.kind === "closed" ? "closed" : "settled";
  record.cleanup_phase = "releasing_directory";
  persist(state, record);
  const receipt = await settlementMutation(state, record, "worker.release", {
    launchId: record.launch_id!,
    proof,
    herdrClosed: true,
    ...(record.lease_id ? { leaseId: record.lease_id, leaseHolder: record.lease_holder } : {}),
    ...(record.report_receipt || record.delivery_receipt
      ? { receiptId: (record.report_receipt ?? record.delivery_receipt)!.id }
      : {}),
  });
  record.cleanup_phase = "directory_released";
  persist(state, record);
  return receipt;
}

async function sendWorker(
  state: WorkerState,
  record: WorkerRecord,
  message: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    if (record.terminal_outcome)
      return {
        ...publicRecord(record),
        send: "refused",
        reason: "Settled worker is awaiting cleanup; finish cleanup before launching new work",
      };
    const before = await verifyWorkerAgent(state, record, signal);
    record.generation++;
    record.watch?.abort();
    checkpoint(state, record, "prompt.baseline", { completionSeq: before.completionSeq });
    record.phase = "submitting_prompt";
    setStatus(state, record, "starting");
    const intent = prepareLaunchOperation(state, record, "herdr", "agent.prompt", {
      target: record.target,
      binding: record.agent_binding,
      prompt: message,
    });
    await runLaunchOperation(state, intent, () =>
      promptAgent(state.deps, record.target as ExecutionTarget, record.pane_id, message, {
        signal,
        kind: record.agent_kind ?? "omp",
      }),
    );
    const agent = await verifyWorkerAgent(state, record, signal);
    if (promptCompleted(state, record, agent)) setStatus(state, record, "working");
    observe(state, record, agent.status, true);
    return { ...publicRecord(record), send: "sent" };
  } catch (error) {
    observationFailure(state, record, error);
    if (record.status !== "failed") watchWorker(state, record);
    return { ...publicRecord(record), send: "refused", reason: errorMessage(error) };
  }
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
  try {
    await verifyWorkerAgent(state, record, signal);
  } catch (error) {
    observationFailure(state, record, error);
    return { ...publicRecord(record), interrupt: "refused", reason: errorMessage(error) };
  }
  // Stop supervising first: the idle state after Escape is not a finished assignment.
  record.generation++;
  record.watch?.abort();
  try {
    const intent = prepareLaunchOperation(state, record, "herdr", "agent.interrupt", {
      target: record.target,
      binding: record.agent_binding,
    });
    await runLaunchOperation(state, intent, () =>
      interruptAgent(state.deps, record.target as ExecutionTarget, record.pane_id, { signal }),
    );
    updateConnection(state, record, "herdr");
  } catch (error) {
    observationFailure(state, record, error);
    // A lost Escape acknowledgement must not turn the resulting idle state into completion.
    if (machineError(error, "herdr").effect === "unknown") setStatus(state, record, "interrupted");
    else if (record.status !== "failed") watchWorker(state, record);
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
  if (record.terminal_outcome)
    return {
      ...publicRecord(record),
      relaunch: "refused",
      reason: "Settled worker is awaiting cleanup; its assignment must not run again",
    };
  if (!record.prompt)
    return {
      ...publicRecord(record),
      relaunch: "refused",
      reason: "The original assignment was not recorded for this worker",
    };
  const directory = record.worktree ?? record.working_directory;
  if (!directory || !record.model || !record.agent_binding)
    return {
      ...publicRecord(record),
      relaunch: "refused",
      reason:
        "Original directory, exact model and agent binding must be known; close this partial launch (discard: true to abandon work), then launch its assignment again",
    };
  const previousBinding = record.agent_binding;
  const target = await herdrTarget(state, record, signal);
  try {
    const present = await verifyWorkerClosure(state, record, signal);
    // A helper contact proves the allocation is still owned before replacing its terminal.
    const lookup = await workerHostCall(
      state,
      record,
      "worker.lookup",
      { launchId: record.launch_id! },
      { signal },
    );
    if (!lookup.resource)
      throw new HostFailure("LEASE_MISMATCH", "Owned allocation is unavailable");
    restoreResource(record, lookup.resource);
    record.generation++;
    record.watch?.abort();
    const terminalMutation = <T>(op: string, args: unknown, invoke: () => Promise<T>) =>
      runLaunchOperation(state, prepareLaunchOperation(state, record, "herdr", op, args), invoke);
    if (present)
      await terminalMutation("worker.close", { target, binding: previousBinding }, () =>
        closeWorkerSpace(state.deps, target, record, { signal }),
      );
    checkpoint(state, record, "worker.relaunch", { revision: previousBinding.revision + 1, note });
    record.cleanup_phase = undefined;
    record.phase = "opening_space";
    setStatus(state, record, "starting");
    persist(state, record);
    const label = workerLabel(record.kind, record.name);
    const space = await terminalMutation("worker.open", { target, directory, label }, async () => {
      if (record.scope === "project")
        return projectSpace(state, target, record.project!, record.projectPath!, directory, label, {
          signal,
        });
      const workspaceId = await researchSpace(state, target, { signal });
      return {
        workspaceId,
        ...(await createTab(state.deps, target, workspaceId, directory, label, { signal })),
      };
    });
    record.workspace_id = space.workspaceId;
    record.tab_id = space.tabId;
    record.pane_id = space.paneId;
    await recoverWorker(state, record, signal);
    if (record.status === "working" || record.status === "blocked") {
      const observed = await verifyWorkerAgent(state, record, signal);
      observe(state, record, observed.status, true);
    } else watchWorker(state, record);
    record.error = undefined;
    persist(state, record);
    return { ...publicRecord(record), relaunch: "started" };
  } catch (error) {
    observationFailure(state, record, error, "Relaunch refused");
    if (record.status === "starting" || record.status === "working" || record.status === "blocked")
      watchWorker(state, record);
    return { ...publicRecord(record), relaunch: "retained", reason: errorMessage(error) };
  }
}

export function watchWorker(state: WorkerState, record: WorkerRecord): void {
  record.watch?.abort();
  const generation = ++record.generation;
  const controller = new AbortController();
  record.watch = controller;
  const superseded = () =>
    controller.signal.aborted || !isCurrent(state, record) || record.generation !== generation;
  const stopMonitor = monitorProgress(state, record, superseded);
  let reconnecting = record.connection?.herdr.state !== "online";
  void (async () => {
    try {
      while (!superseded()) {
        try {
          if (record.target?.kind === "unresolved_local") await adoptLocalWorker(state, record);
          if (
            record.status === "interrupted" ||
            record.status === "ready" ||
            record.status === "failed"
          )
            return;
          if (record.status === "starting") {
            await recoverWorker(state, record, controller.signal);
            if (record.status === "starting") {
              await delay(CHECK_MS, controller.signal);
              continue;
            }
          }
          if (record.target?.kind === "local" && !reconnecting) {
            await waitForAgent(
              state.deps,
              record.target,
              record.pane_id,
              { signal: controller.signal },
              record.status === "blocked" ? UNTIL_UNBLOCKED : UNTIL_STOPPED,
            );
          }
          const agent = await verifyWorkerAgent(state, record, controller.signal);
          if (superseded()) return;
          state.reconnect.delete(`${targetKey(record.target as ExecutionTarget)}:herdr`);
          reconnecting = false;
          if (agent.status === "idle" || agent.status === "done") {
            await settleWorker(state, record);
            return;
          }
          if (agent.status === "working") {
            record.phase = "running";
            setStatus(state, record, "working");
          } else if (agent.status === "blocked") {
            if (record.status !== "blocked") {
              record.phase = "running";
              setStatus(state, record, "blocked");
              void announceBlocked(state, record);
            }
          } else
            throw new HerdrError("PROTOCOL_MISMATCH", "Herdr returned an unknown lifecycle status");
          if (record.target?.kind === "ssh") {
            // Remote waits can outlive a broken SSH connection; bounded queries isolate hosts.
            await delay(1000, controller.signal);
          }
        } catch (error) {
          if (superseded()) return;
          observationFailure(state, record, error);
          if (record.status === "failed") return;
          reconnecting = true;
          await delay(reconnectDelay(state, record), controller.signal);
        }
      }
    } finally {
      stopMonitor();
      if (record.watch === controller) record.watch = undefined;
    }
  })();
}

function monitorProgress(
  state: WorkerState,
  record: WorkerRecord,
  superseded: () => boolean,
): () => void {
  let turnStarted = Date.parse(record.status_changed_at ?? "") || Date.now();
  let screen: string | undefined;
  let changedAt = Date.now();
  let lastScreenAt: number | undefined;
  let observationGap = 0;
  let staleSent = false;
  let turnSent = false;
  let checking = false;
  let turnStatusAt = record.status_changed_at;
  let screenEpoch = screenEpochs.get(record) ?? 0;
  const timer = setInterval(async () => {
    if (checking || superseded()) return;
    checking = true;
    try {
      if (record.status !== "working") return;
      if (turnStatusAt !== record.status_changed_at) {
        turnStatusAt = record.status_changed_at;
        turnStarted = Date.parse(turnStatusAt ?? "") || Date.now();
        turnSent = false;
        staleSent = false;
        screen = undefined;
      }
      const current = await screenOf(state, record, SCREEN_LINES, record.watch?.signal);
      if (superseded()) return;
      const epoch = screenEpochs.get(record) ?? 0;
      if (epoch !== screenEpoch) {
        screen = undefined;
        screenEpoch = epoch;
      }
      const now = Date.now();
      observationGap = lastScreenAt === undefined ? now - turnStarted : now - lastScreenAt;
      const notice = (kind: string, detail: string) =>
        notify(
          state,
          {
            ...publicRecord(record),
            notice: kind,
            detail,
            ...current,
            ...(current.screen !== undefined ? { output: current.screen } : {}),
            observation_gap_seconds: Math.max(0, Math.round(observationGap / 1000)),
          },
          "Visible worker notice",
        );
      if (current.screen === undefined) {
        screen = undefined;
        changedAt = now;
        if (current.screen_error)
          observationFailure(
            state,
            record,
            new HerdrError(current.screen_error.code, current.screen_error.message),
          );
      } else {
        if (current.screen !== screen) {
          screen = current.screen;
          changedAt = now;
        }
        lastScreenAt = now;
        if (!staleSent && now - changedAt >= STALE_MS) {
          staleSent = true;
          notice("no_progress", `Screen unchanged for ${Math.round((now - changedAt) / 1000)} s`);
        }
      }
      if (!turnSent && now - turnStarted >= TURN_MS) {
        turnSent = true;
        notice(
          "long_turn",
          `Working for ${Math.round((now - turnStarted) / 1000)} s; observation gap ${Math.round(observationGap / 1000)} s`,
        );
      }
      // Helper health must not gate otherwise usable Herdr screens.
      void refreshWorkerHost(state, record, record.watch?.signal);
    } finally {
      checking = false;
    }
  }, CHECK_MS);
  return () => clearInterval(timer);
}

export async function refreshWorkerHost(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<void> {
  const target = record.target;
  if (!target || target.kind === "unresolved_local") return;
  const key = `${targetKey(target)}:helper`;
  if ((state.reconnect.get(key)?.nextAt ?? 0) > Date.now()) return;
  try {
    const lookup = await workerHostCall(
      state,
      record,
      "worker.lookup",
      { launchId: record.launch_id! },
      { signal },
    );
    if (lookup.binding && record.agent_binding) {
      const observed = await verifyWorkerAgent(state, record, signal);
      if (!record.agent_binding.sessionPath && observed.sessionPath) {
        const pending = state.store
          .operations({ name: record.name, launchId: record.launch_id })
          .filter(
            (entry) =>
              entry.operation === "worker.bind-agent" &&
              ["prepared", "sent", "uncertain"].includes(entry.state),
          );
        if (pending.length) {
          for (const intent of pending) {
            let view;
            try {
              view = await workerHostCall(
                state,
                record,
                "operation.get",
                { operationId: intent.id },
                { signal },
              );
            } catch (error) {
              if (
                !(error instanceof HostFailure) ||
                error.detail.code !== "OPERATION_NOT_STARTED" ||
                error.detail.effect !== "none"
              )
                throw error;
              intent.state = "refused";
              intent.error = error.detail;
              intent.updatedAt = new Date().toISOString();
              state.store.saveOperation(intent);
              continue;
            }
            if (view.operationId !== intent.id)
              throw new HostFailure(
                "PROTOCOL_MISMATCH",
                "Binding lookup returned another operation",
              );
            intent.state = view.state === "running" ? "sent" : view.state;
            intent.response = view.result;
            intent.error = view.error;
            intent.updatedAt = new Date().toISOString();
            state.store.saveOperation(intent);
          }
        } else if (lookup.binding.sessionPath === observed.sessionPath) {
          record.agent_binding = lookup.binding;
          persist(state, record);
        } else {
          await bindWorkerAgent(
            state,
            record,
            {
              ...record.agent_binding,
              revision: lookup.binding.revision + 1,
              sessionPath: observed.sessionPath,
            },
            signal,
          );
        }
      }
    }
    state.reconnect.delete(key);
  } catch {
    if (!signal?.aborted) reconnectDelay(state, record, "helper");
  }
}

function pendingSettlement(state: WorkerState, record: WorkerRecord): boolean {
  return !!(
    record.report_receipt ||
    record.delivery_receipt ||
    state.store
      .operations({ name: record.name, launchId: record.launch_id })
      .some(
        (entry) =>
          ["delivery.land", "delivery.push", "report.ack"].includes(entry.operation) &&
          entry.state !== "refused",
      )
  );
}

function retrySettlement(
  state: WorkerState,
  record: WorkerRecord,
  error: unknown,
  retry: () => Promise<unknown>,
): boolean {
  if (!(error instanceof HostFailure) && !(error instanceof HerdrError)) return false;
  const detail = machineError(error, error instanceof HerdrError ? "herdr" : "helper");
  if (
    !["TRANSPORT_OFFLINE", "TIMEOUT", "OPERATION_UNCERTAIN"].includes(detail.code) &&
    !(detail.code === "LOCK_BUSY" && detail.effect === "none")
  )
    return false;
  const channel = detail.channel === "herdr" ? "herdr" : "helper";
  updateConnection(state, record, channel, detail);
  record.watch?.abort();
  const controller = new AbortController();
  const generation = ++record.generation;
  record.watch = controller;
  void delay(reconnectDelay(state, record, channel), controller.signal).then(async () => {
    if (controller.signal.aborted || record.generation !== generation || !isCurrent(state, record))
      return;
    if (record.watch === controller) record.watch = undefined;
    await retry();
  });
  return true;
}

async function settleWorker(state: WorkerState, record: WorkerRecord): Promise<void> {
  const generation = ++record.generation;
  try {
    if (record.terminal_outcome) {
      await finishWorker(state, record, settledOutcome(record, ""), true);
      return;
    }
    const recovering = pendingSettlement(state, record);
    if (!recovering) {
      const agent = await verifyWorkerAgent(state, record);
      if (!["idle", "done"].includes(agent.status))
        throw new Error(`Worker agent is ${agent.status}, not quiescent`);
    }
    const output = await workerResponse(state, record);
    if (record.generation !== generation || !isCurrent(state, record)) return;
    let outcome: Record<string, unknown>;
    if (record.kind === "scout") outcome = await completeScout(state, record, output);
    else if (recovering) outcome = await deliverWorker(state, record, output);
    else {
      record.phase = "delivering";
      persist(state, record);
      const evidence = await workerHostCall(state, record, "worker.inspect", {
        launchId: record.launch_id!,
      });
      if (!evidence.leaseValid || evidence.dirty)
        throw new Error("Worker worktree contains uncommitted changes or has lost ownership");
      if (
        record.hold &&
        evidence.head !== record.delivery_base &&
        !state.store
          .operations({ name: record.name, launchId: record.launch_id })
          .some((entry) => entry.operation.startsWith("delivery.") && entry.state !== "refused")
      ) {
        record.error = undefined;
        setStatus(state, record, "ready");
        notify(
          state,
          terminal(record, "ready", output, {
            head: evidence.head,
            delivery_base: record.delivery_base,
          }),
        );
        return;
      }
      outcome = await deliverWorker(state, record, output);
    }
    if (record.generation === generation && isCurrent(state, record))
      await finishWorker(state, record, outcome, true);
  } catch (error) {
    if (record.generation !== generation || !isCurrent(state, record)) return;
    if (retrySettlement(state, record, error, () => settleWorker(state, record))) return;
    record.phase = "retained";
    setStatus(state, record, "failed");
    record.error = errorMessage(error);
    persist(state, record);
    notify(state, terminal(record, "failed", "", { error: record.error }));
  }
}

async function landWorker(
  state: WorkerState,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (record.terminal_outcome)
    return finishWorker(state, record, settledOutcome(record, ""), false);
  const recovering = pendingSettlement(state, record);
  if (record.status !== "ready" && !recovering)
    return {
      ...publicRecord(record),
      land: "refused",
      reason: `Worker is ${record.status}, not ready to land`,
    };
  const generation = ++record.generation;
  try {
    if (!recovering) {
      const agent = await verifyWorkerAgent(state, record, signal);
      if (!["idle", "done"].includes(agent.status))
        return {
          ...publicRecord(record),
          land: "refused",
          reason: `Worker agent is ${agent.status} again; send it a message to resume supervision`,
        };
    }
    const output = await workerResponse(state, record);
    const outcome = await deliverWorker(state, record, output);
    if (record.generation !== generation || !isCurrent(state, record)) return outcome;
    return await finishWorker(state, record, outcome, false);
  } catch (error) {
    if (
      retrySettlement(state, record, error, async () => {
        const outcome = await landWorker(state, record);
        if (outcome.land !== "retained") notify(state, outcome);
      })
    )
      return { ...publicRecord(record), land: "retained", reason: errorMessage(error) };
    record.phase = "retained";
    setStatus(state, record, "failed");
    record.error = errorMessage(error);
    persist(state, record);
    return terminal(record, "failed", "", { error: record.error });
  }
}

// Response text is informational; a missing conversation must not prevent settlement.
async function workerResponse(state: WorkerState, record: WorkerRecord): Promise<string> {
  try {
    await refreshWorkerHost(state, record);
    const { sessionPath } = await verifyWorkerAgent(state, record);
    if (!sessionPath) return "Worker response unavailable: Herdr reported no session path";
    const response = await workerHostCall(state, record, "session.last-response", {
      launchId: record.launch_id!,
      sessionPath,
    });
    return "text" in response
      ? response.text
      : `Worker response unavailable: ${response.unavailableReason}`;
  } catch (error) {
    return `Worker response unavailable: ${errorMessage(error)}`;
  }
}

async function completeScout(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  record.phase = "collecting_report";
  persist(state, record);
  const target = await herdrTarget(state, record);
  await validateStoredProfile(state, target);
  let intent = state.store
    .operations({ name: record.name, launchId: record.launch_id })
    .findLast((entry) => entry.operation === "report.collect");
  intent ??= prepareLaunchOperation(state, record, "controller", "report.collect", {
    source: record.report_source_path,
    destination: record.report_path,
  });
  const receipt =
    record.report_receipt ??
    (await collectReport(record, intent.id, {
      ...(target.kind === "local" ? { runtime: await localRuntime(state) } : {}),
      transport: { spawnStdio: state.api.spawnStdio },
    }));
  record.report_receipt = receipt;
  persist(state, record);
  intent.state = "confirmed";
  intent.response = receipt;
  intent.updatedAt = new Date().toISOString();
  state.store.saveOperation(intent);
  const ack = await settlementMutation(state, record, "report.ack", {
    launchId: record.launch_id!,
    receipt,
  });
  if (
    ack.receiptId !== receipt.id ||
    ack.sha256 !== receipt.sha256 ||
    ack.byteCount !== receipt.byteCount
  )
    throw new HostFailure(
      "PROTOCOL_MISMATCH",
      "Report acknowledgement differs from durable archive",
    );
  return terminal(record, "completed_with_report", output, {
    report: await readFile(receipt.localPath, "utf8"),
  });
}

async function deliverWorker(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  if (record.delivery_receipt)
    return terminal(record, record.delivery_receipt.kind, output, {
      receipt: record.delivery_receipt,
      branch: record.push_to ?? record.branch,
    });
  record.phase = "delivering";
  persist(state, record);
  return record.push_to
    ? pushWorker(state, record, output)
    : queueProjectDelivery(state, record, output);
}

async function pushWorker(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  const receipt = await settlementMutation(state, record, "delivery.push", async () => {
    const agent = await verifyWorkerAgent(state, record);
    if (!["idle", "done"].includes(agent.status))
      throw new Error(`Worker agent is ${agent.status}, not quiescent`);
    const evidence = await workerHostCall(state, record, "worker.inspect", {
      launchId: record.launch_id!,
    });
    if (!evidence.head || evidence.dirty || !evidence.leaseValid)
      throw new Error("Worker worktree is dirty or unowned");
    return {
      launchId: record.launch_id!,
      pushTo: record.push_to!,
      expectedWorkerHead: evidence.head,
    };
  });
  return recordDelivery(state, record, receipt, output);
}

function queueProjectDelivery(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  const key = `${(record.target as ExecutionTarget).hostId}:${record.project_path_key}`;
  const prior = state.deliveryQueues.get(key) ?? Promise.resolve();
  const result = prior.then(() => deliverProject(state, record, output));
  const completed = result.then(
    () => {},
    () => {},
  );
  state.deliveryQueues.set(key, completed);
  void completed.then(() => {
    if (state.deliveryQueues.get(key) === completed) state.deliveryQueues.delete(key);
  });
  return result;
}

async function deliverProject(
  state: WorkerState,
  record: WorkerRecord,
  output: string,
): Promise<Record<string, unknown>> {
  const receipt = await settlementMutation(state, record, "delivery.land", async () => {
    const evidence = await workerHostCall(state, record, "worker.inspect", {
      launchId: record.launch_id!,
    });
    if (!evidence.head || evidence.dirty || !evidence.leaseValid)
      throw new Error("Worker worktree is dirty or unowned");
    const agent = await verifyWorkerAgent(state, record);
    if (!["idle", "done"].includes(agent.status))
      throw new Error(`Worker agent is ${agent.status}, not quiescent`);
    return {
      launchId: record.launch_id!,
      expectedBranch: record.branch!,
      deliveryBase: record.delivery_base!,
      expectedWorkerHead: evidence.head,
    };
  });
  return recordDelivery(state, record, receipt, output);
}

function recordDelivery(
  state: WorkerState,
  record: WorkerRecord,
  receipt: DeliveryReceipt,
  output: string,
): Record<string, unknown> {
  if (receipt.launchId !== record.launch_id)
    throw new HostFailure("PROTOCOL_MISMATCH", "Delivery receipt belongs to another launch");
  record.delivery_receipt = receipt;
  record.delivery_base = receipt.deliveryBase;
  persist(state, record);
  return terminal(record, receipt.kind, output, {
    receipt,
    branch: record.push_to ?? record.branch,
  });
}

function settledOutcome(record: WorkerRecord, output: string): Record<string, unknown> {
  const outcome = record.terminal_outcome!;
  if (outcome.kind === "closed" || outcome.kind === "discarded")
    return { ...publicRecord(record), close: "closed" };
  return terminal(record, outcome.kind, output, {
    receipt: outcome.receipt,
    branch: record.push_to ?? record.branch,
  });
}

async function finishWorker(
  state: WorkerState,
  record: WorkerRecord,
  outcome: Record<string, unknown>,
  announce: boolean,
): Promise<Record<string, unknown>> {
  if (!isCurrent(state, record)) return outcome;
  if (!record.terminal_outcome) {
    record.terminal_outcome =
      record.kind === "scout"
        ? { kind: "completed_with_report", receipt: record.report_receipt! }
        : { kind: record.delivery_receipt!.kind, receipt: record.delivery_receipt! };
  }
  record.phase = "cleaning";
  persist(state, record);
  try {
    if (record.cleanup_phase !== "complete") {
      await closeTopology(state, record);
      const receipt = await releaseWorker(state, record);
      await settlementMutation(state, record, "worker.forget", {
        launchId: record.launch_id!,
        cleanupReceiptId: receipt.id,
      });
      record.cleanup_phase = "complete";
    }
    record.phase = "finished";
    persist(state, record);
    const completed = {
      ...outcome,
      phase: record.phase,
      cleanup_phase: record.cleanup_phase,
      cleanup_pending: false,
    };
    const event = state.store.delete(record.name, announce ? eventMessage(completed) : undefined);
    state.records.delete(record.name);
    if (event) deliver(state, event);
    return completed;
  } catch (error) {
    record.phase = "retained";
    record.error = `Cleanup pending: ${errorMessage(error)}`;
    persist(state, record);
    const retained = {
      ...outcome,
      phase: record.phase,
      connection: record.connection,
      cleanup_phase: record.cleanup_phase,
      cleanup_pending: true,
      cleanup_error: machineError(error, error instanceof HerdrError ? "herdr" : "helper"),
    };
    if (announce) notify(state, retained);
    return retained;
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
    machine: record.target?.machineId ?? "local",
    ...(record.target && record.target.kind !== "unresolved_local"
      ? { session: record.target.session, os: record.target.os }
      : {}),
    connection: record.connection ?? unknownConnection(),
    phase: record.phase,
    cleanup_phase: record.cleanup_phase,
    report_receipt: record.report_receipt,
    delivery_receipt: record.delivery_receipt,
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
    approval: "exec",
    description:
      "Supervise workers launched by orchestrator_task; use it instead of hub. Ops: list; events returns supervisor notifications not yet delivered to this session (all: recent history too); read recent screen lines; send an answer or changed requirement; interrupt a running turn (send resumes it); relaunch a dead or stuck worker in its same worktree with a recovery note; land a held implementation that is ready; close workers. close refuses implementation work that is uncommitted or undelivered unless discard is true. Only the supervising session can change workers; other sessions can list and read.",
    parameters: z.union([
      z.object({ op: z.literal("list"), machine: z.string().optional() }).strict(),
      z.object({ op: z.literal("events"), all: z.boolean().optional() }).strict(),
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
    execute: async (params, signal) => runWorkers(state, params as WorkersParams, signal),
    onSession: (reason) => handleSession(state, reason),
  };
};

export default workersTool;
