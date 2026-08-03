import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lstat, readFile, rm } from "node:fs/promises";
import { errorMessage, NAME, text, type WorkerRecord, type WorkersParams, type ToolResult, WorkerContext } from "./shared";

export class WorkersRuntime {
	constructor(readonly context: WorkerContext) {}

	async run(params: WorkersParams, signal?: AbortSignal): Promise<ToolResult> {
		this.context.active = true;
		try {
			if (params.op === "list") {
				const records = [...this.context.workers.values()].sort((a, b) => a.name.localeCompare(b.name)).map(record => this.publicRecord(record));
				return text(`Visible workers:\n${JSON.stringify(records, null, 2)}`, records);
			}
			if (!Array.isArray(params.names) || params.names.length === 0 || new Set(params.names).size !== params.names.length) throw new Error("Worker names must be a non-empty unique list");
			if (!params.message?.trim()) throw new Error("Worker message must be non-empty");
			const records = params.names.map(name => {
				if (!NAME.test(name)) throw new Error(`Invalid worker name: ${name}`);
				const record = this.context.workers.get(name);
				if (!record) throw new Error(`Unknown visible worker: ${name}`);
				return record;
			});
			const outcomes = await Promise.all(records.map(record => this.#send(record, params.message, signal)));
			return text(`Visible worker messages:\n${JSON.stringify(outcomes, null, 2)}`, outcomes);
		} catch (error) {
			return text(errorMessage(error), undefined, true);
		}
	}

	has(name: string): boolean {
		return this.context.workers.has(name);
	}

	adopt(record: WorkerRecord, status: string): void {
		this.context.workers.set(record.name, record);
		if (status === "working") this.#watch(record);
		else if (status === "idle" || status === "done") void this.#settle(record);
		else if (status === "blocked") queueMicrotask(() => this.context.notify(this.#terminal(record, "blocked", "")));
		else throw new Error(`Unexpected Herdr agent status: ${status}`);
	}

	dispose(): void {
		this.context.active = false;
		for (const record of this.context.workers.values()) record.watch?.abort();
		this.context.workers.clear();
	}

	publicRecord(record: WorkerRecord): Record<string, unknown> {
		return { kind: record.kind, ...(record.scope === "independent" ? { scope: "independent" } : { project: record.project }), name: record.name, ...(record.role ? { role: record.role } : {}), status: record.status, workspace_id: record.workspace_id, tab_id: record.tab_id, pane_id: record.pane_id, ...(record.scope === "independent" ? { working_directory: record.working_directory } : { worktree: record.worktree, lease_id: record.lease_id, delivery_base: record.delivery_base }), ...(record.push_to ? { push_to: record.push_to } : {}), ...(record.report_path ? { report_path: record.report_path, ...(record.scope === "project" ? { local_changes: record.local_changes ?? "" } : {}) } : {}), ...(record.error ? { error: record.error } : {}) };
	}

	async #send(record: WorkerRecord, message: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		record.generation++;
		record.watch?.abort();
		try {
			await this.context.prompt(record.pane_id, message, signal);
		} catch (error) {
			record.error = errorMessage(error);
		}
		try {
			const agent = await this.context.agent(record.pane_id, signal);
			if (agent.identity !== "omp") throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
			if (agent.status === "working") { record.status = "working"; record.error = undefined; this.#watch(record); }
			else if (agent.status === "idle" || agent.status === "done") void this.#settle(record);
			else if (agent.status === "blocked") { record.status = "blocked"; queueMicrotask(() => this.context.notify(this.#terminal(record, "blocked", ""))); }
			else throw new Error(`Unexpected Herdr agent status: ${agent.status}`);
		} catch (error) {
			record.status = "failed";
			record.error = errorMessage(error);
			this.context.notify(this.#terminal(record, "failed", "", record.error));
		}
		return this.publicRecord(record);
	}

	#watch(record: WorkerRecord): void {
		const generation = ++record.generation;
		const controller = new AbortController();
		record.watch = controller;
		void (async () => {
			try {
				await this.context.run("herdr", ["agent", "wait", record.pane_id, "--until", "idle", "--until", "done", "--until", "blocked"], { signal: controller.signal });
				if (!this.context.isCurrent(record) || record.generation !== generation) return;
				const agent = await this.context.agent(record.pane_id, controller.signal);
				if (!this.context.isCurrent(record) || record.generation !== generation) return;
				if (agent.status === "idle" || agent.status === "done") await this.#settle(record);
				else if (agent.status === "blocked") { record.status = "blocked"; this.context.notify(this.#terminal(record, "blocked", "")); }
				else throw new Error(`Watcher observed unexpected state: ${agent.status}`);
			} catch (error) {
				if (controller.signal.aborted || !this.context.isCurrent(record) || record.generation !== generation) return;
				record.status = "failed";
				record.error = errorMessage(error);
				this.context.notify(this.#terminal(record, "failed", "", record.error));
			}
		})();
	}

	async #settle(record: WorkerRecord): Promise<void> {
		const generation = ++record.generation;
		try {
			const output = await this.context.run("herdr", ["agent", "read", record.pane_id, "--source", "recent-unwrapped", "--lines", "200", "--format", "text"]);
			if (record.generation !== generation || !this.context.isCurrent(record)) return;
			let outcome: Record<string, unknown>;
			if (record.kind === "scout") {
				outcome = await this.#completeScout(record, output);
			} else {
				const dirty = await this.context.run("git", ["-C", record.worktree!, "status", "--porcelain=v1", "--untracked-files=all"]);
				if (dirty) throw new Error("Worker worktree contains uncommitted changes");
				outcome = record.push_to ? await this.#push(record, output) : await this.#queueLocal(record, output);
			}
			if (record.generation === generation && this.context.isCurrent(record)) await this.#finish(record, outcome);
		} catch (error) {
			if (record.generation !== generation || !this.context.isCurrent(record)) return;
			record.status = "failed";
			record.error = errorMessage(error);
			this.context.notify(this.#terminal(record, "failed", "", record.error));
		}
	}

	async #completeScout(record: WorkerRecord, output: string): Promise<Record<string, unknown>> {
		const path = record.report_path;
		if (!path) throw new Error("Scout report path is missing");
		let info;
		try { info = await lstat(path); } catch (error) { throw new Error(`Scout report is missing or unreadable: ${path}: ${errorMessage(error)}`); }
		if (!info.isFile()) throw new Error(`Scout report is not a regular file: ${path}`);
		let report: string;
		try { report = await readFile(path, "utf8"); } catch (error) { throw new Error(`Scout report is unreadable: ${path}: ${errorMessage(error)}`); }
		if (!report.trim()) throw new Error(`Scout report is empty: ${path}`);
		return this.#terminal(record, "completed_with_report", output, undefined, undefined, report);
	}

	async #push(record: WorkerRecord, output: string): Promise<Record<string, unknown>> {
		await this.context.run("git", ["-C", record.worktree!, "push", "origin", `HEAD:refs/heads/${record.push_to}`]);
		return this.#terminal(record, "pushed", output, undefined, record.push_to);
	}

	#queueLocal(record: WorkerRecord, output: string): Promise<Record<string, unknown>> {
		let resolveOutcome!: (value: Record<string, unknown>) => void;
		let rejectOutcome!: (reason: unknown) => void;
		const result = new Promise<Record<string, unknown>>((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
		this.context.deliveryQueue = this.context.deliveryQueue.then(async () => {
			try { resolveOutcome(await this.#deliverLocal(record, output)); } catch (error) { rejectOutcome(error); }
		}, rejectOutcome);
		return result;
	}

	async #deliverLocal(record: WorkerRecord, output: string): Promise<Record<string, unknown>> {
		const workerHead = (await this.context.run("git", ["-C", record.worktree!, "rev-parse", "HEAD"])).trim();
		if (workerHead === record.delivery_base) return this.#terminal(record, "no_changes", output, undefined, record.branch);
		await this.#assertTarget(record);
		try {
			await this.context.run("git", ["-C", record.projectPath!, "merge", "--ff-only", workerHead]);
		} catch (firstError) {
			const current = (await this.context.run("git", ["-C", record.projectPath!, "rev-parse", "HEAD"])).trim();
			if (current === record.delivery_base) throw firstError;
			try {
				await this.context.run("git", ["-C", record.worktree!, "rebase", "--onto", current, record.delivery_base!, workerHead]);
			} catch (error) {
				await this.context.bestEffort("git", ["-C", record.worktree!, "rebase", "--abort"]);
				throw error;
			}
			record.delivery_base = current;
			const rebasedHead = (await this.context.run("git", ["-C", record.worktree!, "rev-parse", "HEAD"])).trim();
			await this.#assertTarget(record);
			await this.context.run("git", ["-C", record.projectPath!, "merge", "--ff-only", rebasedHead]);
		}
		return this.#terminal(record, "merged", output, undefined, record.branch);
	}

	async #assertTarget(record: WorkerRecord): Promise<void> {
		const dirty = await this.context.run("git", ["-C", record.projectPath!, "status", "--porcelain=v1", "--untracked-files=all"]);
		if (dirty) throw new Error("Registered project became dirty before delivery");
		const branch = (await this.context.run("git", ["-C", record.projectPath!, "symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
		if (!branch || branch !== record.branch) throw new Error(`Registered project branch changed before delivery (expected ${record.branch})`);
	}

	async #finish(record: WorkerRecord, outcome: Record<string, unknown>): Promise<void> {
		if (!this.context.isCurrent(record)) return;
		try {
			await this.context.run("herdr", ["tab", "close", record.tab_id]);
			if (!this.context.isCurrent(record)) return;
			if (record.scope === "independent") {
				if (!record.working_directory) throw new Error("Independent working directory is missing");
				await rm(record.working_directory, { recursive: true });
			} else {
				await this.context.run("treehouse", ["return", "--force", "--if-lease-id", record.lease_id!, "--if-lease-holder", record.lease_holder!, record.worktree!]);
			}
			this.context.workers.delete(record.name);
			this.context.notify(outcome);
		} catch (error) {
			record.status = "failed";
			record.error = `Cleanup failed: ${errorMessage(error)}`;
			this.context.notify(this.#terminal(record, "failed", String(outcome.output ?? ""), record.error));
		}
	}

	#terminal(record: WorkerRecord, status: "merged" | "pushed" | "no_changes" | "completed_with_report" | "blocked" | "failed", output: string, error?: string, branch?: string, report?: string): Record<string, unknown> {
		return { kind: record.kind, ...(record.scope === "independent" ? { scope: "independent" } : { project: record.project }), name: record.name, ...(record.role ? { role: record.role } : {}), status, output, ...(branch ? { branch } : {}), ...(report ? { report } : {}), ...(record.report_path ? { report_path: record.report_path, ...(record.scope === "project" ? { local_changes: record.local_changes ?? "" } : {}) } : {}), ...(error ? { error } : {}), workspace_id: record.workspace_id, tab_id: record.tab_id, pane_id: record.pane_id, ...(record.scope === "independent" ? { working_directory: record.working_directory } : { worktree: record.worktree, lease_id: record.lease_id }) };
	}
}

export function registerWorkersTool(pi: ExtensionAPI, runtime: WorkersRuntime): void {
	const { z } = pi.zod;
	pi.registerTool({
		name: "workers", label: "Workers", loadMode: "essential", approval: "exec",
		description: "List visible worker agents or send a plan change to named workers. Use this instead of hub for workers launched by task.",
		parameters: z.discriminatedUnion("op", [z.object({ op: z.literal("list") }), z.object({ op: z.literal("send"), names: z.array(z.string()).min(1), message: z.string() })]),
		execute: async (_id: string, params: WorkersParams, signal?: AbortSignal) => runtime.run(params, signal),
	});
}
