import type { ExtensionAPI, CustomToolResult } from "@oh-my-pi/pi-coding-agent";

export type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
export type RuntimeDeps = {
  exec: ExtensionAPI["exec"];
  sendMessage(message: string, options: { triggerTurn: true; deliverAs: "nextTurn" }): void;
  logger: ExtensionAPI["logger"];
};

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
  pushTo?: string;
  startFrom?: string;
};
export type ProjectTaskParams = { project: string; context: string; tasks: TaskItem[] };
export type IndependentTaskParams = { scope: "independent"; context: string; tasks: TaskItem[] };
export type TaskParams = ProjectTaskParams | IndependentTaskParams;
export type WorkersParams = { op: "list" } | { op: "send"; names: string[]; message: string };
export type ProjectPreflight = {
  scope: "project";
  project: string;
  projectPath: string;
  workspace: string;
  head: string;
  branch?: string;
  localChanges: string;
  starts: Record<string, string>;
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
  status: "working" | "blocked" | "failed";
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  worktree?: string;
  working_directory?: string;
  lease_id?: string;
  lease_holder?: string;
  delivery_base?: string;
  branch?: string;
  push_to?: string;
  report_path?: string;
  local_changes?: string;
  error?: string;
  generation: number;
  watch?: AbortController;
};

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LEASE_ID = /^[0-9a-fA-F]{32}$/;
export const IMPLEMENTATION_PROMPT_SUFFIX =
  "Complete this assignment directly; do not delegate to subagents. Commit all assignment changes before reporting completion.";

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

export function parseJson(value: string, command: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${command} returned invalid JSON`);
  }
}

export function stringAt(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current))
      return undefined;
    current = current[key as keyof typeof current];
  }
  return typeof current === "string" ? current : undefined;
}
