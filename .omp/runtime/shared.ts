import type { ExtensionAPI, CustomToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

export type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
export type RuntimeDeps = {
  exec: ExtensionAPI["exec"];
  sendMessage(message: string, options: { triggerTurn: true; deliverAs: "nextTurn" }): void;
  logger: ExtensionAPI["logger"];
};
export type ToolAPI = RuntimeDeps & {
  cwd: string;
  zod: ExtensionAPI["zod"];
  env?: Record<string, string | undefined>;
  neutralRoot?: string;
};
export type ToolFactory = (api: ToolAPI) => ToolDefinition<any, any>;

export type ProjectParams =
  | { op: "list" }
  | { op: "add"; name: string; path: string }
  | { op: "create"; name: string; path?: string }
  | { op: "remove"; name: string }
  | { op: "set-root"; path: string };
export type TaskKind = "implementation" | "scout";
export type TaskItem = {
  kind: TaskKind;
  name: string;
  task: string;
  role?: string;
  /** Exact `provider/id`, optionally with a `:level` thinking suffix; mutually exclusive with role. */
  model?: string;
  /** Set by the task tool when it splits a `:level` suffix off `model`; never caller input. */
  thinking?: string;
  pushTo?: string;
  startFrom?: string;
  hold?: boolean;
};
export type ProjectTaskParams = { project: string; context: string; tasks: TaskItem[] };
export type IndependentTaskParams = { scope: "independent"; context: string; tasks: TaskItem[] };
export type TaskParams = ProjectTaskParams | IndependentTaskParams;
export type WorkersParams =
  | { op: "list" }
  | { op: "read"; names: string[]; lines?: number }
  | { op: "send"; names: string[]; message: string }
  | { op: "interrupt"; names: string[] }
  | { op: "relaunch"; names: string[]; note: string }
  | { op: "land"; names: string[] }
  | { op: "close"; names: string[]; discard?: boolean };
export type ModelsParams =
  | { op: "list"; view?: "preferred" | "all"; provider?: string; q?: string; limit?: number }
  | { op: "prefer"; model: string; for?: string[]; rank?: number; note?: string }
  | { op: "avoid"; model: string; note?: string }
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
};
export type IndependentPreflight = {
  scope: "independent";
  workspace: string;
  forbiddenRoots: string[];
};
export type Preflight = ProjectPreflight | IndependentPreflight;
export type WorkerRecord = {
  scope: "project" | "independent";
  kind: TaskKind;
  project?: string;
  projectPath?: string;
  name: string;
  role?: string;
  model?: string;
  thinking?: string;
  status: "working" | "blocked" | "interrupted" | "ready" | "failed";
  workspace_id: string;
  tab_id: string;
  pane_id: string;
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
  generation: number;
  watch?: AbortController;
};

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LEASE_ID = /^[0-9a-fA-F]{32}$/;

export const projectNameSchema = (z: ExtensionAPI["zod"]) =>
  z.union([
    z.literal("_independent"),
    z
      .string()
      .regex(NAME, "Project name must be 1-64 characters of letters, digits, '.', '_', or '-'"),
  ]);

export function text(text: string, details?: unknown, isError = false): CustomToolResult {
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
