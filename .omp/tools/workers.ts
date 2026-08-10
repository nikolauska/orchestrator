import type { CustomToolAPI, CustomToolFactory, CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, readFile, rm } from "node:fs/promises";
import {
  abortRebaseBestEffort,
  currentBranchAt,
  fastForward,
  headAt,
  pushHead,
  rebaseOnto,
  statusAt,
} from "../runtime/git";
import { closeTab, getAgent, promptAgent, readAgent, waitForAgent } from "../runtime/herdr";
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
  deliveryQueue: Promise<void>;
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
    deliveryQueue: Promise.resolve(),
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

export function adoptWorker(state: WorkerState, record: WorkerRecord, status: string): void {
  state.records.set(record.name, record);
  if (status === "working") watchWorker(state, record);
  else if (status === "idle" || status === "done") void settleWorker(state, record);
  else if (status === "blocked")
    queueMicrotask(() => notify(state, terminal(record, "blocked", "")));
  else throw new Error(`Unexpected Herdr agent status: ${status}`);
}

export function disposeWorkers(state: WorkerState): void {
  state.active = false;
  for (const record of state.records.values()) record.watch?.abort();
  state.records.clear();
}

export async function runWorkers(
  state: WorkerState,
  params: WorkersParams,
  signal?: AbortSignal,
): Promise<CustomToolResult> {
  state.active = true;
  try {
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
    if (!params.message?.trim()) throw new Error("Worker message must be non-empty");
    const records = params.names.map((name) => {
      if (!NAME.test(name)) throw new Error(`Invalid worker name: ${name}`);
      const record = state.records.get(name);
      if (!record) throw new Error(`Unknown visible worker: ${name}`);
      return record;
    });
    const outcomes = await Promise.all(
      records.map((record) => sendWorker(state, record, params.message, signal)),
    );
    return text(`Visible worker messages:\n${JSON.stringify(outcomes, null, 2)}`, outcomes);
  } catch (error) {
    return text(errorMessage(error), undefined, true);
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
    await closeTab(state.deps, record.tab_id);
    if (!isCurrent(state, record)) return;
    if (record.scope === "independent") {
      if (!record.working_directory) throw new Error("Independent working directory is missing");
      await rm(record.working_directory, { recursive: true });
    } else {
      await returnLease(state.deps, {
        path: record.worktree!,
        leaseId: record.lease_id!,
        leaseHolder: record.lease_holder!,
      });
    }
    state.records.delete(record.name);
    notify(state, outcome);
  } catch (error) {
    record.status = "failed";
    record.error = `Cleanup failed: ${errorMessage(error)}`;
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
      "List visible worker agents or send a plan change to named workers. Use this instead of hub for workers launched by orchestrator_task. Workers MUST NOT create new workers.",
    parameters: z.union([
      z.object({ op: z.literal("list") }).strict(),
      z
        .object({ op: z.literal("send"), names: z.array(z.string()).min(1), message: z.string() })
        .strict(),
    ]),
    execute: async (_id, params, _onUpdate, _ctx, signal) =>
      runWorkers(state, params as WorkersParams, signal),
    onSession: (event) => {
      if (event.reason === "switch" || event.reason === "shutdown") disposeWorkers(state);
    },
  };
};

export default workersTool;
