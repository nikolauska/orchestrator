import { homedir } from "node:os";
import { join } from "node:path";

export type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
export type RuntimeDeps = {
	exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<ExecResult>;
	sendMessage(message: string, options: { triggerTurn: true; deliverAs: "nextTurn" }): void;
	logger: { debug?(message: string, details?: unknown): void; warn?(message: string, details?: unknown): void };
};

export type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean; details?: unknown };
export type ProjectParams = { op: "list" } | { op: "add"; name: string; path: string } | { op: "create"; name: string; path?: string } | { op: "remove"; name: string } | { op: "set-root"; path: string };
export type TaskKind = "implementation" | "scout";
export type TaskItem = { kind: TaskKind; name: string; task: string; role?: string; pushTo?: string; startFrom?: string };
export type ProjectTaskParams = { project: string; context: string; tasks: TaskItem[] };
export type IndependentTaskParams = { scope: "independent"; context: string; tasks: TaskItem[] };
export type TaskParams = ProjectTaskParams | IndependentTaskParams;
export type WorkersParams = { op: "list" } | { op: "send"; names: string[]; message: string };
export type AgentState = "idle" | "working" | "blocked" | "done";
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
export type IndependentPreflight = { scope: "independent"; workspace: string; forbiddenRoots: string[] };
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
export const IMPLEMENTATION_PROMPT_SUFFIX = "Complete this assignment directly; do not delegate to subagents. Commit all assignment changes before reporting completion.";

export function text(text: string, details?: unknown, isError = false): ToolResult {
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
		if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) return undefined;
		current = current[key as keyof typeof current];
	}
	return typeof current === "string" ? current : undefined;
}

export class WorkerContext {
	readonly workers = new Map<string, WorkerRecord>();
	#deliveryQueue: Promise<void> = Promise.resolve();
	active = true;

	constructor(
		readonly deps: RuntimeDeps,
		readonly root = process.cwd(),
		readonly env: Record<string, string | undefined> = process.env,
		readonly neutralRoot = join(homedir(), ".omp", "orchestrator", "independent-workers"),
	) {}

	get deliveryQueue(): Promise<void> { return this.#deliveryQueue; }
	set deliveryQueue(queue: Promise<void>) { this.#deliveryQueue = queue; }

	async run(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
		const result = await this.deps.exec(command, args, options);
		if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
		return result.stdout.trim();
	}

	async bestEffort(command: string, args: string[], signal?: AbortSignal): Promise<void> {
		try { await this.run(command, args, { signal }); } catch (error) { this.deps.logger.warn?.("Visible worker cleanup failed", { command, error: errorMessage(error) }); }
	}

	async agent(pane: string, signal?: AbortSignal): Promise<{ identity: string; status: AgentState | string }> {
		const value = parseJson(await this.run("herdr", ["agent", "get", pane], { signal }), "herdr agent get");
		return { identity: stringAt(value, ["result", "agent", "agent"]) ?? "", status: stringAt(value, ["result", "agent", "agent_status"]) ?? "" };
	}

	async prompt(pane: string, message: string, signal?: AbortSignal): Promise<void> {
		try {
			await this.run("herdr", ["agent", "prompt", pane, message, "--wait", "--until", "working", "--until", "done", "--until", "blocked", "--timeout", "30000"], { signal });
		} catch (error) {
			if (!errorMessage(error).includes("agent_prompt_stalled")) throw error;
			// Herdr has already typed the text when startup stalls; retry only Enter to avoid duplicating the assignment.
			await this.run("herdr", ["agent", "send-keys", pane, "enter"], { signal });
			await this.run("herdr", ["agent", "wait", pane, "--until", "working", "--until", "done", "--until", "blocked", "--timeout", "5000"], { signal });
		}
	}

	isCurrent(record: WorkerRecord): boolean {
		return this.active && this.workers.get(record.name) === record;
	}

	notify(outcome: Record<string, unknown>): void {
		if (!this.active) return;
		this.deps.sendMessage(`Visible worker result:\n${JSON.stringify(outcome, null, 2)}`, { triggerTurn: true, deliverAs: "nextTurn" });
	}
}
