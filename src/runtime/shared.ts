import type { HarnessServices, ToolOutcome, ToolSpec, Zod } from "../core/tool";
import type { ConfigurationContext, ExecutionTarget, StoredTarget } from "./execution";
import type { HostRuntime } from "./host";
import type { OmpContextResolver } from "./omp";
import type {
  AgentBinding,
  DeliveryReceipt,
  HostError,
  ReleaseReceipt,
  ReportReceipt,
} from "./helper-protocol";

export type StdioProcess = {
  stdin: { write(data: string | Uint8Array): void | Promise<void>; end(): void | Promise<void> };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};
export type StdioSpawn = (
  command: string[],
  options: { signal?: AbortSignal; cwd?: string },
) => StdioProcess;
export type WorkerPhase =
  | "preflighted"
  | "allocating"
  | "opening_space"
  | "starting_agent"
  | "submitting_prompt"
  | "running"
  | "collecting_report"
  | "delivering"
  | "retained"
  | "cleaning"
  | "finished";
export type CleanupPhase =
  | "not_started"
  | "closing_space"
  | "space_closed"
  | "releasing_directory"
  | "directory_released"
  | "complete";
export type ChannelConnection = {
  state: "unknown" | "online" | "offline" | "attention";
  lastSuccessAt?: string;
  error?: HostError;
};
export type WorkerConnection = {
  herdr: ChannelConnection;
  helper: ChannelConnection;
  state: ChannelConnection["state"];
};
export type TerminalOutcome =
  | { kind: "completed_with_report"; receipt: ReportReceipt }
  | { kind: "merged" | "pushed" | "no_changes"; receipt: DeliveryReceipt }
  | { kind: "closed" | "discarded"; authorizedAt: string; releaseReceipt?: ReleaseReceipt };

export type { ExecResult } from "../core/tool";
export type RuntimeDeps = HarnessServices & { spawnStdio?: StdioSpawn };
export type ToolAPI = RuntimeDeps & {
  cwd: string;
  zod: Zod;
  env?: Record<string, string | undefined>;
  neutralRoot?: string;
  target?: ExecutionTarget;
  localHostRuntime?: HostRuntime;
  resolveOmpContext?: OmpContextResolver;
};
export type ToolFactory = (api: ToolAPI) => ToolSpec;

export type ProjectParams =
  | { op: "list"; machine?: string }
  | { op: "add"; name: string; path: string; machine?: string }
  | { op: "create"; name: string; path?: string; machine?: string }
  | { op: "remove"; name: string }
  | { op: "set-root"; path: string; machine?: string };
export type MachinesParams =
  | { op: "list" }
  | { op: "status"; machine?: string }
  | { op: "check" | "set-default"; machine: string };
export type TaskKind = "implementation" | "scout";
export type TaskItem = {
  kind: TaskKind;
  name: string;
  task: string;
  /** Worker agent; omitted means OMP. */
  agent?: "omp" | "claude";
  role?: string;
  /** Exact `provider/id`, optionally with a `:level` thinking suffix; mutually exclusive with role. */
  model?: string;
  /** Set by the task tool when it splits a `:level` suffix off `model`; never caller input. */
  thinking?: string;
  /** Claude Code workers only: start with Remote Control so the user can follow them remotely. */
  remoteControl?: boolean;
  pushTo?: string;
  startFrom?: string;
  hold?: boolean;
};
export type ProjectTaskParams = { project: string; context: string; tasks: TaskItem[] };
export type IndependentTaskParams = { scope: "independent"; context: string; tasks: TaskItem[] };
export type TaskParams = ProjectTaskParams | IndependentTaskParams;
export type WorkersParams =
  | { op: "list"; machine?: string }
  | { op: "events"; all?: boolean }
  | { op: "read"; names: string[]; lines?: number }
  | { op: "send"; names: string[]; message: string }
  | { op: "interrupt"; names: string[] }
  | { op: "relaunch"; names: string[]; note: string }
  | { op: "land"; names: string[] }
  | { op: "close"; names: string[]; discard?: boolean };
export type ModelsParams =
  | { op: "list"; view?: "preferred" | "all"; provider?: string; q?: string; limit?: number }
  | {
      op: "prefer";
      model: string;
      agent?: "omp" | "claude";
      for?: string[];
      rank?: number;
      note?: string;
    }
  | { op: "avoid"; model: string; agent?: "omp" | "claude"; note?: string }
  | { op: "forget"; model: string };
export type ProjectPreflight = {
  scope: "project";
  project: string;
  projectPath: string;
  head: string;
  branch?: string;
  localChanges: string;
  starts: Record<string, string>;
  /** Per-worker note when its starting branch lacks commits its remote already has. */
  originWarnings: Record<string, string>;
  target?: ExecutionTarget;
  projectPathKey?: string;
};
export type IndependentPreflight = {
  scope: "independent";
  workspace: string;
  forbiddenRoots: string[];
  target?: ExecutionTarget;
};
export type Preflight = ProjectPreflight | IndependentPreflight;
export type WorkerRecord = {
  scope: "project" | "independent";
  kind: TaskKind;
  project?: string;
  projectPath?: string;
  name: string;
  /** Worker agent; absent means OMP, which every older record is. */
  agent_kind?: "claude";
  /** Claude Code Remote Control session, named after the worker; kept across relaunch. */
  remote_control?: boolean;
  role?: string;
  model?: string;
  thinking?: string;
  status: "starting" | "working" | "blocked" | "interrupted" | "ready" | "failed";
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  worktree?: string;
  working_directory?: string;
  lease_id?: string;
  lease_holder?: string;
  delivery_base?: string;
  branch?: string;
  start_from?: string;
  push_to?: string;
  hold?: boolean;
  report_path?: string;
  local_changes?: string;
  prompt?: string;
  error?: string;
  launched_at?: string;
  updated_at?: string;
  controller_id?: string;
  launch_id?: string;
  target?: StoredTarget;
  project_path_key?: string;
  agent_name?: string;
  agent_binding?: AgentBinding;
  phase?: WorkerPhase;
  connection?: WorkerConnection;
  /** Lifecycle transition time; updated_at also advances for connection and receipt writes. */
  status_changed_at?: string;
  source_head?: string;
  worker_config_path?: string;
  worker_config_sha256?: string;
  configuration_context?: ConfigurationContext;
  report_source_path?: string;
  report_receipt?: ReportReceipt;
  delivery_receipt?: DeliveryReceipt;
  cleanup_phase?: CleanupPhase;
  terminal_outcome?: TerminalOutcome;
  generation: number;
  watch?: AbortController;
};

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LEASE_ID = /^[0-9a-fA-F]{32}$/;

export const projectNameSchema = (z: Zod) =>
  z.union([
    z.literal("_independent"),
    z
      .string()
      .regex(NAME, "Project name must be 1-64 characters of letters, digits, '.', '_', or '-'"),
  ]);

export function text(text: string, details?: unknown, isError = false): ToolOutcome {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function execCommand(
  deps: RuntimeDeps,
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<string> {
  const result = await deps.exec(command, args, options);
  if (result.code !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
    );
  return result.stdout.trim();
}

export function parseJson(value: string, command: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${command} returned invalid JSON`);
  }
}

export function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current))
      return undefined;
    current = current[key as keyof typeof current];
  }
  return current;
}

export function stringAt(value: unknown, path: string[]): string | undefined {
  const current = valueAt(value, path);
  return typeof current === "string" ? current : undefined;
}
