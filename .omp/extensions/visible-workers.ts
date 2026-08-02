import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";

export type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
export type RuntimeDeps = {
	exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<ExecResult>;
	sendMessage(message: string, options: { triggerTurn: true; deliverAs: "nextTurn" }): void;
	logger: { debug?(message: string, details?: unknown): void; warn?(message: string, details?: unknown): void };
};

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean; details?: unknown };
type ProjectParams = { op: "list" } | { op: "add"; name: string; path: string } | { op: "remove"; name: string };
type TaskKind = "implementation" | "scout";
type TaskItem = { kind: TaskKind; name: string; task: string; role?: string; pushTo?: string };
type ProjectTaskParams = { project: string; context: string; tasks: TaskItem[] };
type IndependentTaskParams = { scope: "independent"; context: string; tasks: TaskItem[] };
type TaskParams = ProjectTaskParams | IndependentTaskParams;
type WorkersParams = { op: "list" } | { op: "send"; names: string[]; message: string };
type AgentState = "idle" | "working" | "blocked" | "done";
type ProjectPreflight = {
	scope: "project";
	project: string;
	projectPath: string;
	workspace: string;
	head: string;
	branch?: string;
	localChanges: string;
};
type IndependentPreflight = { scope: "independent"; workspace: string; forbiddenRoots: string[] };
type Preflight = ProjectPreflight | IndependentPreflight;


type WorkerRecord = {
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

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LEASE_ID = /^[0-9a-fA-F]{32}$/;
const IMPLEMENTATION_PROMPT_SUFFIX = "Complete this assignment directly; do not delegate to subagents. Commit all assignment changes before reporting completion.";

function text(text: string, details?: unknown, isError = false): ToolResult {
	return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseJson(value: string, command: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`${command} returned invalid JSON`);
	}
}

function stringAt(value: unknown, path: string[]): string | undefined {
	let current = value;
	for (const key of path) {
		if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) return undefined;
		current = current[key as keyof typeof current];
	}
	return typeof current === "string" ? current : undefined;
}

export class VisibleWorkerRuntime {
	readonly #deps: RuntimeDeps;
	readonly #root: string;
	readonly #neutralRoot: string;
	readonly #env: Record<string, string | undefined>;
	readonly #workers = new Map<string, WorkerRecord>();
	#deliveryQueue: Promise<void> = Promise.resolve();
	#active = true;

	constructor(deps: RuntimeDeps, root = process.cwd(), env: Record<string, string | undefined> = process.env, neutralRoot = join(homedir(), ".omp", "orchestrator", "independent-workers")) {
		this.#deps = deps;
		this.#root = root;
		this.#neutralRoot = neutralRoot;
		this.#env = env;
	}

	async runProjects(params: ProjectParams, signal?: AbortSignal): Promise<ToolResult> {
		this.#active = true;
		try {
			const projects = await this.#readProjects();
			if (params.op === "list") return this.#projectResult(projects);
			this.#validateName(params.name, "project");
			if (params.op === "remove") {
				if (!(params.name in projects)) throw new Error(`Unknown registered project: ${params.name}`);
				delete projects[params.name];
				await this.#writeProjects(projects);
				return this.#projectResult(projects);
			}
			const input = params.path.startsWith("~/") ? join(homedir(), params.path.slice(2)) : params.path;
			if (!isAbsolute(input)) throw new Error("Project path must be absolute or start with ~/");
			const canonical = await realpath(input);
			const top = await this.#run("git", ["rev-parse", "--show-toplevel"], { cwd: canonical, signal });
			const gitRoot = await realpath(top.trim());
			if (gitRoot !== canonical) throw new Error(`Path is not an exact Git root: ${canonical}`);
			if (projects[params.name] && projects[params.name] !== canonical) throw new Error(`Project name already registered: ${params.name}`);
			const other = Object.entries(projects).find(([name, path]) => name !== params.name && path === canonical);
			if (other) throw new Error(`Project path already registered as ${other[0]}`);
			if (projects[params.name] !== canonical) {
				projects[params.name] = canonical;
				await this.#writeProjects(projects);
			}
			return this.#projectResult(projects);
		} catch (error) {
			return text(errorMessage(error), undefined, true);
		}
	}

	async runTask(params: TaskParams, signal?: AbortSignal): Promise<ToolResult> {
		this.#active = true;
		try {
			this.#validateTask(params);
			if (!("scope" in params)) {
				// OMP's strict tool schema transport materializes omitted optional strings as ""; keep omission as default behavior.
				params = { ...params, tasks: params.tasks.map(({ pushTo, role, ...item }) => ({ ...item, ...(pushTo ? { pushTo } : {}), ...(role ? { role } : {}) })) };
			}
			const active = params.tasks.find(item => this.#workers.has(item.name));
			if (active) throw new Error(`Worker name already retained: ${active.name}`);
			const preflight = await this.#preflight(params, signal);
			const launched = await Promise.all(params.tasks.map(item => this.#launch(preflight, params.context, item, signal)));
			return text(`Visible workers launched:\n${JSON.stringify(launched, null, 2)}`, launched);
		} catch (error) {
			return text(errorMessage(error), undefined, true);
		}
	}

	async runWorkers(params: WorkersParams, signal?: AbortSignal): Promise<ToolResult> {
		this.#active = true;
		try {
			if (params.op === "list") {
				const records = [...this.#workers.values()].sort((a, b) => a.name.localeCompare(b.name)).map(record => this.#publicRecord(record));
				return text(`Visible workers:\n${JSON.stringify(records, null, 2)}`, records);
			}
			if (!Array.isArray(params.names) || params.names.length === 0 || new Set(params.names).size !== params.names.length) throw new Error("Worker names must be a non-empty unique list");
			if (!params.message?.trim()) throw new Error("Worker message must be non-empty");
			const records = params.names.map(name => {
				if (!NAME.test(name)) throw new Error(`Invalid worker name: ${name}`);
				const record = this.#workers.get(name);
				if (!record) throw new Error(`Unknown visible worker: ${name}`);
				return record;
			});
			const outcomes = await Promise.all(records.map(record => this.#send(record, params.message, signal)));
			return text(`Visible worker messages:\n${JSON.stringify(outcomes, null, 2)}`, outcomes);
		} catch (error) {
			return text(errorMessage(error), undefined, true);
		}
	}

	dispose(): void {
		this.#active = false;
		for (const record of this.#workers.values()) record.watch?.abort();
		this.#workers.clear();
	}

	async #readProjects(): Promise<Record<string, string>> {
		let raw: string;
		try {
			raw = await readFile(this.#registryPath(), "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
			throw error;
		}
		let parsed: unknown;
		try { parsed = JSON.parse(raw); } catch { throw new Error("Malformed .omp/projects.json"); }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Malformed .omp/projects.json");
		for (const [name, path] of Object.entries(parsed)) {
			if (!NAME.test(name) || typeof path !== "string") throw new Error("Malformed .omp/projects.json");
		}
		return parsed as Record<string, string>;
	}

	async #writeProjects(projects: Record<string, string>): Promise<void> {
		const path = this.#registryPath();
		await mkdir(dirname(path), { recursive: true });
		const sorted = Object.fromEntries(Object.entries(projects).sort(([a], [b]) => a.localeCompare(b)));
		const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx" });
		await rename(temp, path);
	}

	#registryPath(): string { return join(this.#root, ".omp", "projects.json"); }

	#projectResult(projects: Record<string, string>): ToolResult {
		const items = Object.entries(projects).sort(([a], [b]) => a.localeCompare(b)).map(([name, path]) => ({ name, path }));
		return text(`Registered projects:\n${JSON.stringify(items, null, 2)}`, items);
	}

	#validateName(name: string, kind: string): void {
		if (typeof name !== "string" || !NAME.test(name)) throw new Error(`Invalid ${kind} name: ${name}`);
	}

	#validateTask(params: TaskParams): void {
		if (!params || typeof params !== "object") throw new Error("Malformed task scope");
		const hasProject = Object.prototype.hasOwnProperty.call(params, "project");
		const hasScope = Object.prototype.hasOwnProperty.call(params, "scope");
		if (hasProject === hasScope) throw new Error("Task must set exactly one project or independent scope");
		const independent = hasScope;
		if (independent) {
			if ((params as IndependentTaskParams).scope !== "independent") throw new Error("Invalid task scope");
		} else if (typeof (params as ProjectTaskParams).project !== "string" || !NAME.test((params as ProjectTaskParams).project)) {
			throw new Error("Invalid registered project name");
		}
		if (typeof params.context !== "string") throw new Error("Task context must be a string");
		if (!Array.isArray(params.tasks) || params.tasks.length < 1 || params.tasks.length > 32) throw new Error("Tasks must contain 1 to 32 items");
		const names = new Set<string>();
		for (const item of params.tasks) {
			this.#validateName(item.name, "worker");
			if (names.has(item.name)) throw new Error(`Duplicate worker name: ${item.name}`);
			names.add(item.name);
			if (item.kind !== "implementation" && item.kind !== "scout") throw new Error(`Invalid task kind for ${item.name}: ${item.kind}`);
			if (typeof item.task !== "string" || !item.task.trim()) throw new Error(`Task for ${item.name} must be non-empty`);
			if (item.role !== undefined && item.role !== "" && (typeof item.role !== "string" || !NAME.test(item.role))) throw new Error(`Invalid OMP model role for ${item.name}: ${item.role}`);
			if (independent && item.kind !== "scout") throw new Error("Independent scope accepts scout tasks only");
			if (independent && item.pushTo !== undefined) throw new Error(`Independent scout ${item.name} cannot set pushTo`);
			if (!independent && item.kind === "scout" && item.pushTo !== undefined) throw new Error(`Scout task ${item.name} cannot set pushTo`);
			if (!independent && item.pushTo !== undefined && item.pushTo !== "" && !item.pushTo.trim()) throw new Error(`pushTo for ${item.name} must be non-empty`);
		}
	}

	async #preflight(params: TaskParams, signal?: AbortSignal): Promise<Preflight> {
		if ("scope" in params) {
			const workspace = await this.#workspace(["herdr", "omp"], signal);
			const projects = await this.#readProjects();
			const root = await realpath(this.#root);
			return { scope: "independent", workspace, forbiddenRoots: [root, ...Object.values(projects)] };
		}
		const projects = await this.#readProjects();
		const projectPath = projects[params.project];
		if (!projectPath) throw new Error(`Unknown registered project: ${params.project}. Registered: ${Object.keys(projects).sort().join(", ") || "(none)"}`);
		const workspace = await this.#workspace(["herdr", "treehouse", "git", "omp"], signal);
		let canonical: string;
		try { canonical = await realpath(projectPath); } catch { throw new Error(`Registered project path is missing: ${projectPath}`); }
		const top = await this.#run("git", ["rev-parse", "--show-toplevel"], { cwd: canonical, signal });
		if (await realpath(top.trim()) !== canonical || canonical !== projectPath) throw new Error(`Registered path is not its exact Git root: ${projectPath}`);
		const head = (await this.#run("git", ["rev-parse", "HEAD"], { cwd: canonical, signal })).trim();
		for (const item of params.tasks) if (item.pushTo) await this.#run("git", ["check-ref-format", "--branch", item.pushTo], { cwd: canonical, signal });
		const needsLocalDelivery = params.tasks.some(item => item.kind === "implementation" && !item.pushTo);
		const needsLocalChanges = needsLocalDelivery || params.tasks.some(item => item.kind === "scout");
		const localChanges = needsLocalChanges
			? await this.#run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: canonical, signal })
			: "";
		let branch: string | undefined;
		if (needsLocalDelivery) {
			if (localChanges) throw new Error(`Registered project must be clean for local delivery: ${params.project}`);
			branch = (await this.#run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: canonical, signal })).trim();
			if (!branch) throw new Error("Local delivery requires a named branch");
		}
		return { scope: "project", project: params.project, projectPath: canonical, workspace, head, branch, localChanges };
	}

	async #workspace(commands: string[], signal?: AbortSignal): Promise<string> {
		const pane = this.#env.HERDR_PANE_ID;
		const workspace = pane?.split(":", 1)[0];
		if (this.#env.HERDR_ENV !== "1" || !this.#env.HERDR_SOCKET_PATH || !workspace) throw new Error("Herdr's OMP integration is required; run `herdr integration install omp` and restart OMP");
		await Promise.all(commands.map(command => this.#run(command, ["--version"], { signal })));
		return workspace;
	}

	async #launch(preflight: Preflight, context: string, item: TaskItem, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const leaseHolder = `omp-orchestrator:${item.name}`;
		let lease: { path: string; lease_id: string; lease_holder: string } | undefined;
		let directory: string | undefined;
		let tabId: string | undefined;
		let paneId: string | undefined;
		let ompMayHaveStarted = false;
		const reportPath = item.kind === "scout"
			? join(this.#root, ".omp", "reports", preflight.scope === "independent" ? "_independent" : preflight.project, `${crypto.randomUUID()}-${item.name}.md`)
			: undefined;
		try {
			if (preflight.scope === "project") {
				const leaseJson = parseJson(await this.#run("treehouse", ["get", "--lease", "--lease-holder", leaseHolder, "--json"], { cwd: preflight.projectPath, signal }), "treehouse get");
				const leasePath = stringAt(leaseJson, ["path"]);
				const leaseId = stringAt(leaseJson, ["lease_id"]);
				const echoedHolder = stringAt(leaseJson, ["lease_holder"]);
				if (!leasePath || !isAbsolute(leasePath) || !leaseId || !LEASE_ID.test(leaseId) || echoedHolder !== leaseHolder) throw new Error("treehouse get returned an unrecognized lease");
				lease = { path: leasePath, lease_id: leaseId, lease_holder: echoedHolder };
				directory = lease.path;
				await this.#run("git", ["-C", directory, "reset", "--hard", preflight.head], { signal });
			} else {
				await mkdir(this.#neutralRoot, { recursive: true });
				const base = await realpath(this.#neutralRoot);
				for (const forbidden of preflight.forbiddenRoots) {
					const placement = relative(forbidden, base);
					if (!placement || (placement !== ".." && !placement.startsWith(`..${sep}`))) throw new Error(`Neutral working directory base is inside reserved project context: ${forbidden}`);
				}
				const candidate = join(base, `${crypto.randomUUID()}-${item.name}`);
				await mkdir(candidate);
				directory = await realpath(candidate);
				for (const forbidden of preflight.forbiddenRoots) {
					const placement = relative(forbidden, directory);
					if (!placement || (placement !== ".." && !placement.startsWith(`..${sep}`))) throw new Error(`Neutral working directory is inside reserved project context: ${forbidden}`);
				}
			}
			if (!directory) throw new Error("Worker directory was not allocated");
			if (reportPath) await mkdir(dirname(reportPath), { recursive: true });
			const tabJson = parseJson(await this.#run("herdr", ["tab", "create", "--workspace", preflight.workspace, "--cwd", directory, "--label", item.name, "--no-focus"], { signal }), "herdr tab create");
			tabId = stringAt(tabJson, ["result", "tab", "tab_id"]);
			paneId = stringAt(tabJson, ["result", "root_pane", "pane_id"]);
			if (!tabId || !paneId) throw new Error("herdr tab create returned unrecognized identifiers");
			// Tab creation returns before the startup shell necessarily reaches its prompt; agent start rejects a transiently busy pane.
			await this.#run("herdr", ["pane", "wait-output", paneId, "--regex", "[#$>]\\s*$", "--source", "visible", "--lines", "10", "--timeout", "5000"], { signal });
			ompMayHaveStarted = true;
			await this.#run("herdr", ["agent", "start", item.name, "--kind", "omp", "--pane", paneId, "--", "--cwd", directory, ...(item.role ? ["--model", `@${item.role}`] : [])], { signal });
			const prompt = item.kind === "implementation"
				? `${context}\n\n${IMPLEMENTATION_PROMPT_SUFFIX}\n\n${item.task}`
				: preflight.scope === "project"
					? `${context}\n\nResearch only the exact committed revision ${preflight.head}; the registered checkout's local changes are excluded from this disposable worktree.${preflight.localChanges ? ` Disclose these excluded local changes in the report:\n${preflight.localChanges}` : " The registered checkout has no local changes to exclude."}\nYou may make scratch edits or commits only in this disposable worktree. They will never be delivered. Write the authoritative, non-empty standalone Markdown report to ${reportPath}. Cover the investigation, findings, evidence, recommendations, and unresolved decisions as useful without fixed headings. Return a concise terminal conclusion. Unresolved decisions do not block completion. Complete this assignment directly; do not delegate to subagents. Do not implement changes for delivery.\n\n${item.task}`
					: `${context}\n\nThis is a project-independent scout. No registered-project checkout or project revision applies, and project-specific context is intentionally excluded. Global and user OMP instructions still apply. Scratch files in ${directory} are disposable and are never delivered; do not create commits. Public web search and reads of public URLs are enabled by default. Access authenticated external systems only when this assignment explicitly instructs it. Write the authoritative, non-empty standalone Markdown report to ${reportPath}. Include source URLs and the research date. Cover the investigation, findings, evidence, recommendations, and unresolved decisions as useful without fixed headings. Return a concise terminal conclusion. Unresolved decisions do not block completion. Complete this assignment directly; do not delegate to subagents. Do not implement changes for delivery.\n\n${item.task}`;
			await this.#prompt(paneId, prompt, signal);
			const agent = await this.#agent(paneId, signal);
			if (agent.identity !== "omp") throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
			const record: WorkerRecord = {
				scope: preflight.scope, kind: item.kind, name: item.name, role: item.role, status: agent.status === "blocked" ? "blocked" : "working",
				workspace_id: preflight.workspace, tab_id: tabId, pane_id: paneId,
				...(preflight.scope === "project"
					? { project: preflight.project, projectPath: preflight.projectPath, worktree: directory, lease_id: lease!.lease_id, lease_holder: lease!.lease_holder, delivery_base: preflight.head, branch: preflight.branch, push_to: item.pushTo, local_changes: item.kind === "scout" ? preflight.localChanges : undefined }
					: { working_directory: directory }),
				report_path: reportPath, generation: 0,
			};
			this.#workers.set(item.name, record);
			if (agent.status === "working") this.#watch(record);
			else if (agent.status === "idle" || agent.status === "done") void this.#settle(record, agent.status);
			else if (agent.status === "blocked") queueMicrotask(() => this.#notify(this.#terminal(record, "blocked", "")));
			else throw new Error(`Unexpected Herdr agent status: ${agent.status}`);
			return this.#publicRecord(record);
		} catch (error) {
			const message = errorMessage(error);
			if (!ompMayHaveStarted) {
				if (tabId) await this.#bestEffort("herdr", ["tab", "close", tabId], signal);
				if (lease) await this.#bestEffort("treehouse", ["return", "--force", "--if-lease-id", lease.lease_id, "--if-lease-holder", lease.lease_holder, lease.path], signal);
				else if (directory) {
					try { await rm(directory, { recursive: true }); } catch (cleanupError) { this.#deps.logger.warn?.("Visible worker cleanup failed", { directory, error: errorMessage(cleanupError) }); }
				}
			} else if (directory && tabId && paneId) {
				const record: WorkerRecord = {
					scope: preflight.scope, kind: item.kind, name: item.name, role: item.role, status: "failed", workspace_id: preflight.workspace, tab_id: tabId, pane_id: paneId,
					...(preflight.scope === "project"
						? { project: preflight.project, projectPath: preflight.projectPath, worktree: directory, lease_id: lease!.lease_id, lease_holder: lease!.lease_holder, delivery_base: preflight.head, branch: preflight.branch, push_to: item.pushTo, local_changes: item.kind === "scout" ? preflight.localChanges : undefined }
						: { working_directory: directory }),
					report_path: reportPath, error: message, generation: 0,
				};
				this.#workers.set(item.name, record);
				return this.#publicRecord(record);
			}
			return { kind: item.kind, ...(preflight.scope === "independent" ? { scope: "independent" } : { project: preflight.project, delivery_base: preflight.head }), name: item.name, ...(item.role ? { role: item.role } : {}), status: "failed", ...(directory ? preflight.scope === "independent" ? { working_directory: directory } : { worktree: directory, lease_id: lease?.lease_id } : {}), ...(tabId ? { workspace_id: preflight.workspace, tab_id: tabId } : {}), ...(paneId ? { pane_id: paneId } : {}), ...(item.pushTo ? { push_to: item.pushTo } : {}), ...(reportPath ? { report_path: reportPath, ...(preflight.scope === "project" ? { local_changes: preflight.localChanges } : {}) } : {}), error: message };
		}
	}

	async #send(record: WorkerRecord, message: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		record.generation++;
		record.watch?.abort();
		try {
			await this.#prompt(record.pane_id, message, signal);
		} catch (error) {
			record.error = errorMessage(error);
		}
		try {
			const agent = await this.#agent(record.pane_id, signal);
			if (agent.identity !== "omp") throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
			if (agent.status === "working") { record.status = "working"; record.error = undefined; this.#watch(record); }
			else if (agent.status === "idle" || agent.status === "done") void this.#settle(record, agent.status);
			else if (agent.status === "blocked") { record.status = "blocked"; queueMicrotask(() => this.#notify(this.#terminal(record, "blocked", ""))); }
			else throw new Error(`Unexpected Herdr agent status: ${agent.status}`);
		} catch (error) {
			record.status = "failed";
			record.error = errorMessage(error);
			this.#notify(this.#terminal(record, "failed", "", record.error));
		}
		return this.#publicRecord(record);
	}

	#watch(record: WorkerRecord): void {
		const generation = ++record.generation;
		const controller = new AbortController();
		record.watch = controller;
		void (async () => {
			try {
				await this.#run("herdr", ["agent", "wait", record.pane_id, "--until", "idle", "--until", "done", "--until", "blocked"], { signal: controller.signal });
				if (!this.#isCurrent(record) || record.generation !== generation) return;
				const agent = await this.#agent(record.pane_id, controller.signal);
				if (!this.#isCurrent(record) || record.generation !== generation) return;
				if (agent.status === "idle" || agent.status === "done") await this.#settle(record, agent.status);
				else if (agent.status === "blocked") { record.status = "blocked"; this.#notify(this.#terminal(record, "blocked", "")); }
				else throw new Error(`Watcher observed unexpected state: ${agent.status}`);
			} catch (error) {
				if (controller.signal.aborted || !this.#isCurrent(record) || record.generation !== generation) return;
				record.status = "failed";
				record.error = errorMessage(error);
				this.#notify(this.#terminal(record, "failed", "", record.error));
			}
		})();
	}

	async #settle(record: WorkerRecord, _state: "idle" | "done"): Promise<void> {
		const generation = ++record.generation;
		try {
			const output = await this.#run("herdr", ["agent", "read", record.pane_id, "--source", "recent-unwrapped", "--lines", "200", "--format", "text"]);
			if (record.generation !== generation || !this.#isCurrent(record)) return;
			let outcome: Record<string, unknown>;
			if (record.kind === "scout") {
				outcome = await this.#completeScout(record, output);
			} else {
				const dirty = await this.#run("git", ["-C", record.worktree!, "status", "--porcelain=v1", "--untracked-files=all"]);
				if (dirty) throw new Error("Worker worktree contains uncommitted changes");
				outcome = record.push_to ? await this.#push(record, output) : await this.#queueLocal(record, output);
			}
			if (record.generation === generation && this.#isCurrent(record)) await this.#finish(record, outcome);
		} catch (error) {
			if (record.generation !== generation || !this.#isCurrent(record)) return;
			record.status = "failed";
			record.error = errorMessage(error);
			this.#notify(this.#terminal(record, "failed", "", record.error));
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


	async #push(record: WorkerRecord, output: string) {
		await this.#run("git", ["-C", record.worktree!, "push", "origin", `HEAD:refs/heads/${record.push_to}`]);
		return this.#terminal(record, "pushed", output, undefined, record.push_to);
	}

	#queueLocal(record: WorkerRecord, output: string): Promise<Record<string, unknown>> {
		let resolveOutcome!: (value: Record<string, unknown>) => void;
		let rejectOutcome!: (reason: unknown) => void;
		const result = new Promise<Record<string, unknown>>((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
		this.#deliveryQueue = this.#deliveryQueue.then(async () => {
			try { resolveOutcome(await this.#deliverLocal(record, output)); } catch (error) { rejectOutcome(error); }
		}, rejectOutcome);
		return result;
	}

	async #deliverLocal(record: WorkerRecord, output: string): Promise<Record<string, unknown>> {
		const workerHead = (await this.#run("git", ["-C", record.worktree!, "rev-parse", "HEAD"])).trim();
		if (workerHead === record.delivery_base) return this.#terminal(record, "no_changes", output, undefined, record.branch);
		await this.#assertTarget(record);
		try {
			await this.#run("git", ["-C", record.projectPath!, "merge", "--ff-only", workerHead]);
		} catch (firstError) {
			const current = (await this.#run("git", ["-C", record.projectPath!, "rev-parse", "HEAD"])).trim();
			if (current === record.delivery_base) throw firstError;
			try {
				await this.#run("git", ["-C", record.worktree!, "rebase", "--onto", current, record.delivery_base!, workerHead]);
			} catch (error) {
				await this.#bestEffort("git", ["-C", record.worktree!, "rebase", "--abort"]);
				throw error;
			}
			record.delivery_base = current;
			const rebasedHead = (await this.#run("git", ["-C", record.worktree!, "rev-parse", "HEAD"])).trim();
			await this.#assertTarget(record);
			await this.#run("git", ["-C", record.projectPath!, "merge", "--ff-only", rebasedHead]);
		}
		return this.#terminal(record, "merged", output, undefined, record.branch);
	}

	async #assertTarget(record: WorkerRecord): Promise<void> {
		const dirty = await this.#run("git", ["-C", record.projectPath!, "status", "--porcelain=v1", "--untracked-files=all"]);
		if (dirty) throw new Error("Registered project became dirty before delivery");
		const branch = (await this.#run("git", ["-C", record.projectPath!, "symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
		if (!branch || branch !== record.branch) throw new Error(`Registered project branch changed before delivery (expected ${record.branch})`);
	}

	async #finish(record: WorkerRecord, outcome: Record<string, unknown>): Promise<void> {
		if (!this.#isCurrent(record)) return;
		try {
			await this.#run("herdr", ["tab", "close", record.tab_id]);
			if (!this.#isCurrent(record)) return;
			if (record.scope === "independent") {
				if (!record.working_directory) throw new Error("Independent working directory is missing");
				await rm(record.working_directory, { recursive: true });
			} else {
				await this.#run("treehouse", ["return", "--force", "--if-lease-id", record.lease_id!, "--if-lease-holder", record.lease_holder!, record.worktree!]);
			}
			this.#workers.delete(record.name);
			this.#notify(outcome);
		} catch (error) {
			record.status = "failed";
			record.error = `Cleanup failed: ${errorMessage(error)}`;
			this.#notify(this.#terminal(record, "failed", String(outcome.output ?? ""), record.error));
		}
	}

	#terminal(record: WorkerRecord, status: "merged" | "pushed" | "no_changes" | "completed_with_report" | "blocked" | "failed", output: string, error?: string, branch?: string, report?: string): Record<string, unknown> {
		return { kind: record.kind, ...(record.scope === "independent" ? { scope: "independent" } : { project: record.project }), name: record.name, ...(record.role ? { role: record.role } : {}), status, output, ...(branch ? { branch } : {}), ...(report ? { report } : {}), ...(record.report_path ? { report_path: record.report_path, ...(record.scope === "project" ? { local_changes: record.local_changes ?? "" } : {}) } : {}), ...(error ? { error } : {}), workspace_id: record.workspace_id, tab_id: record.tab_id, pane_id: record.pane_id, ...(record.scope === "independent" ? { working_directory: record.working_directory } : { worktree: record.worktree, lease_id: record.lease_id }) };
	}

	#notify(outcome: Record<string, unknown>): void {
		if (!this.#active) return;
		this.#deps.sendMessage(`Visible worker result:\n${JSON.stringify(outcome, null, 2)}`, { triggerTurn: true, deliverAs: "nextTurn" });
	}

	#publicRecord(record: WorkerRecord): Record<string, unknown> {
		return { kind: record.kind, ...(record.scope === "independent" ? { scope: "independent" } : { project: record.project }), name: record.name, ...(record.role ? { role: record.role } : {}), status: record.status, workspace_id: record.workspace_id, tab_id: record.tab_id, pane_id: record.pane_id, ...(record.scope === "independent" ? { working_directory: record.working_directory } : { worktree: record.worktree, lease_id: record.lease_id, delivery_base: record.delivery_base }), ...(record.push_to ? { push_to: record.push_to } : {}), ...(record.report_path ? { report_path: record.report_path, ...(record.scope === "project" ? { local_changes: record.local_changes ?? "" } : {}) } : {}), ...(record.error ? { error: record.error } : {}) };
	}

	async #agent(pane: string, signal?: AbortSignal): Promise<{ identity: string; status: AgentState | string }> {
		const value = parseJson(await this.#run("herdr", ["agent", "get", pane], { signal }), "herdr agent get");
		return { identity: stringAt(value, ["result", "agent", "agent"]) ?? "", status: stringAt(value, ["result", "agent", "agent_status"]) ?? "" };
	}

	async #prompt(pane: string, message: string, signal?: AbortSignal): Promise<void> {
		try {
			await this.#run("herdr", ["agent", "prompt", pane, message, "--wait", "--until", "working", "--until", "done", "--until", "blocked", "--timeout", "30000"], { signal });
		} catch (error) {
			if (!errorMessage(error).includes("agent_prompt_stalled")) throw error;
			// Herdr has already typed the text when startup stalls; retry only Enter to avoid duplicating the assignment.
			await this.#run("herdr", ["agent", "send-keys", pane, "enter"], { signal });
			await this.#run("herdr", ["agent", "wait", pane, "--until", "working", "--until", "done", "--until", "blocked", "--timeout", "5000"], { signal });
		}
	}

	#isCurrent(record: WorkerRecord): boolean {
		return this.#active && this.#workers.get(record.name) === record;
	}

	async #run(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
		const result = await this.#deps.exec(command, args, options);
		if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
		return result.stdout.trim();
	}

	async #bestEffort(command: string, args: string[], signal?: AbortSignal): Promise<void> {
		try { await this.#run(command, args, { signal }); } catch (error) { this.#deps.logger.warn?.("Visible worker cleanup failed", { command, error: errorMessage(error) }); }
	}
}

export default function visibleWorkersExtension(pi: ExtensionAPI): void {
	const { z } = pi.zod;
	const runtime = new VisibleWorkerRuntime({ exec: pi.exec.bind(pi), sendMessage: pi.sendMessage.bind(pi), logger: pi.logger });
	pi.registerTool({
		name: "projects", label: "Projects", loadMode: "essential", approval: "write",
		description: "Manage registered local Git projects used by visible worker tasks. Removal unregisters only; it never deletes a repository.",
		parameters: z.discriminatedUnion("op", [z.object({ op: z.literal("list") }), z.object({ op: z.literal("add"), name: z.string(), path: z.string() }), z.object({ op: z.literal("remove"), name: z.string() })]),
		execute: async (_id: string, params: ProjectParams, signal?: AbortSignal) => runtime.runProjects(params, signal),
	});
	pi.registerTool({
		name: "task", label: "Visible Workers", loadMode: "essential", approval: "exec",
		description: "Launch project-scoped implementation or scout OMP workers, or project-independent scouts, in visible Herdr tabs. Project workers use isolated Treehouse worktrees; independent scouts use unique neutral working directories and public web research by default. One task call has one scope. Each assignment may select an OMP model role: smol for bounded research or mechanical work, slow for deep diagnosis or review, plan for architecture/schema/migration planning, designer for UI/UX, or vision for image inspection; omit role for normal work. Scouts produce durable reports and cannot deliver changes. Returns after launch; completion wakes this root session. Use projects to list targets and workers, not hub, to list or message agents.",
		parameters: z.union([
			z.object({ project: z.string(), context: z.string(), tasks: z.array(z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("implementation"), name: z.string(), task: z.string(), role: z.string().optional(), pushTo: z.string().optional() }).strict(),
				z.object({ kind: z.literal("scout"), name: z.string(), task: z.string(), role: z.string().optional() }).strict(),
			])).min(1).max(32) }).strict(),
			z.object({ scope: z.literal("independent"), context: z.string(), tasks: z.array(z.object({ kind: z.literal("scout"), name: z.string(), task: z.string(), role: z.string().optional() }).strict()).min(1).max(32) }).strict(),
		]),
		execute: async (_id: string, params: TaskParams, signal?: AbortSignal) => runtime.runTask(params, signal),
	});
	pi.registerTool({
		name: "workers", label: "Workers", loadMode: "essential", approval: "exec",
		description: "List visible worker agents or send a plan change to named workers. Use this instead of hub for workers launched by task.",
		parameters: z.discriminatedUnion("op", [z.object({ op: z.literal("list") }), z.object({ op: z.literal("send"), names: z.array(z.string()).min(1), message: z.string() })]),
		execute: async (_id: string, params: WorkersParams, signal?: AbortSignal) => runtime.runWorkers(params, signal),
	});
	pi.on("session_switch", () => runtime.dispose());
	pi.on("session_shutdown", () => runtime.dispose());
}
