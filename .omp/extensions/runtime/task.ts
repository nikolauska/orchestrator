import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { mkdir, realpath, rm } from "node:fs/promises";
import { IMPLEMENTATION_PROMPT_SUFFIX, LEASE_ID, NAME, errorMessage, parseJson, stringAt, text, type IndependentTaskParams, type Preflight, type ProjectTaskParams, type TaskItem, type TaskParams, type ToolResult, type WorkerRecord, WorkerContext } from "./shared";
import { ProjectsRuntime } from "./projects";
import { WorkersRuntime } from "./workers";

export class TaskRuntime {
	constructor(readonly context: WorkerContext, readonly projects: ProjectsRuntime, readonly workers: WorkersRuntime) {}

	async run(params: TaskParams, signal?: AbortSignal): Promise<ToolResult> {
		this.context.active = true;
		try {
			this.#validate(params);
			if (!("scope" in params)) {
				// OMP's strict tool schema transport materializes omitted optional strings as ""; keep omission as default behavior.
				params = { ...params, tasks: params.tasks.map(({ pushTo, role, ...item }) => ({ ...item, ...(pushTo ? { pushTo } : {}), ...(role ? { role } : {}) })) };
			}
			const active = params.tasks.find(item => this.workers.has(item.name));
			if (active) throw new Error(`Worker name already retained: ${active.name}`);
			const preflight = await this.#preflight(params, signal);
			const launched = await Promise.all(params.tasks.map(item => this.#launch(preflight, params.context, item, signal)));
			return text(`Visible workers launched:\n${JSON.stringify(launched, null, 2)}`, launched);
		} catch (error) {
			return text(errorMessage(error), undefined, true);
		}
	}

	#validate(params: TaskParams): void {
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
			this.projects.validateName(item.name, "worker");
			if (names.has(item.name)) throw new Error(`Duplicate worker name: ${item.name}`);
			names.add(item.name);
			if (item.kind !== "implementation" && item.kind !== "scout") throw new Error(`Invalid task kind for ${item.name}: ${item.kind}`);
			if (typeof item.task !== "string" || !item.task.trim()) throw new Error(`Task for ${item.name} must be non-empty`);
			if (item.role !== undefined && (typeof item.role !== "string" || !NAME.test(item.role))) throw new Error(`Invalid OMP model role for ${item.name}: ${item.role}`);
			if (independent && item.kind !== "scout") throw new Error("Independent scope accepts scout tasks only");
			if (independent && item.pushTo !== undefined) throw new Error(`Independent scout ${item.name} cannot set pushTo`);
			if (!independent && item.kind === "scout" && item.pushTo !== undefined) throw new Error(`Scout task ${item.name} cannot set pushTo`);
			if (!independent && item.pushTo !== undefined && (typeof item.pushTo !== "string" || !item.pushTo.trim())) throw new Error(`pushTo for ${item.name} must be non-empty`);
		}
	}

	async #preflight(params: TaskParams, signal?: AbortSignal): Promise<Preflight> {
		if ("scope" in params) {
			const workspace = await this.#workspace(["herdr", "omp"], signal);
			const projects = await this.projects.read();
			const root = await realpath(this.context.root);
			return { scope: "independent", workspace, forbiddenRoots: [root, ...Object.values(projects)] };
		}
		const projects = await this.projects.read();
		const projectPath = projects[params.project];
		if (!projectPath) throw new Error(`Unknown registered project: ${params.project}. Registered: ${Object.keys(projects).sort().join(", ") || "(none)"}`);
		const workspace = await this.#workspace(["herdr", "treehouse", "git", "omp"], signal);
		let canonical: string;
		try { canonical = await realpath(projectPath); } catch { throw new Error(`Registered project path is missing: ${projectPath}`); }
		const top = await this.context.run("git", ["rev-parse", "--show-toplevel"], { cwd: canonical, signal });
		if (await realpath(top.trim()) !== canonical || canonical !== projectPath) throw new Error(`Registered path is not its exact Git root: ${projectPath}`);
		const head = (await this.context.run("git", ["rev-parse", "HEAD"], { cwd: canonical, signal })).trim();
		for (const item of params.tasks) if (item.pushTo) await this.context.run("git", ["check-ref-format", "--branch", item.pushTo], { cwd: canonical, signal });
		const needsLocalDelivery = params.tasks.some(item => item.kind === "implementation" && !item.pushTo);
		const needsLocalChanges = needsLocalDelivery || params.tasks.some(item => item.kind === "scout");
		const localChanges = needsLocalChanges
			? await this.context.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: canonical, signal })
			: "";
		let branch: string | undefined;
		if (needsLocalDelivery) {
			if (localChanges) throw new Error(`Registered project must be clean for local delivery: ${params.project}`);
			branch = (await this.context.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: canonical, signal })).trim();
			if (!branch) throw new Error("Local delivery requires a named branch");
		}
		return { scope: "project", project: params.project, projectPath: canonical, workspace, head, branch, localChanges };
	}

	async #workspace(commands: string[], signal?: AbortSignal): Promise<string> {
		const pane = this.context.env.HERDR_PANE_ID;
		const workspace = pane?.split(":", 1)[0];
		if (this.context.env.HERDR_ENV !== "1" || !this.context.env.HERDR_SOCKET_PATH || !workspace) throw new Error("Herdr's OMP integration is required; run `herdr integration install omp` and restart OMP");
		await Promise.all(commands.map(command => this.context.run(command, ["--version"], { signal })));
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
			? join(this.context.root, ".omp", "reports", preflight.scope === "independent" ? "_independent" : preflight.project, `${crypto.randomUUID()}-${item.name}.md`)
			: undefined;
		try {
			if (preflight.scope === "project") {
				const leaseJson = parseJson(await this.context.run("treehouse", ["get", "--lease", "--lease-holder", leaseHolder, "--json"], { cwd: preflight.projectPath, signal }), "treehouse get");
				const leasePath = stringAt(leaseJson, ["path"]);
				const leaseId = stringAt(leaseJson, ["lease_id"]);
				const echoedHolder = stringAt(leaseJson, ["lease_holder"]);
				if (!leasePath || !isAbsolute(leasePath) || !leaseId || !LEASE_ID.test(leaseId) || echoedHolder !== leaseHolder) throw new Error("treehouse get returned an unrecognized lease");
				lease = { path: leasePath, lease_id: leaseId, lease_holder: echoedHolder };
				directory = lease.path;
				await this.context.run("git", ["-C", directory, "reset", "--hard", preflight.head], { signal });
			} else {
				await mkdir(this.context.neutralRoot, { recursive: true });
				const base = await realpath(this.context.neutralRoot);
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
			const tabJson = parseJson(await this.context.run("herdr", ["tab", "create", "--workspace", preflight.workspace, "--cwd", directory, "--label", item.name, "--no-focus"], { signal }), "herdr tab create");
			tabId = stringAt(tabJson, ["result", "tab", "tab_id"]);
			paneId = stringAt(tabJson, ["result", "root_pane", "pane_id"]);
			if (!tabId || !paneId) throw new Error("herdr tab create returned unrecognized identifiers");
			// Tab creation returns before the startup shell necessarily reaches its prompt; agent start rejects a transiently busy pane.
			await this.context.run("herdr", ["pane", "wait-output", paneId, "--regex", "[#$>]\\s*$", "--source", "visible", "--lines", "10", "--timeout", "5000"], { signal });
			ompMayHaveStarted = true;
			await this.context.run("herdr", ["agent", "start", item.name, "--kind", "omp", "--pane", paneId, "--", "--cwd", directory, ...(item.role ? ["--model", `@${item.role}`] : [])], { signal });
			const prompt = item.kind === "implementation"
				? `${context}\n\n${IMPLEMENTATION_PROMPT_SUFFIX}\n\n${item.task}`
				: preflight.scope === "project"
					? `${context}\n\nResearch only the exact committed revision ${preflight.head}; the registered checkout's local changes are excluded from this disposable worktree.${preflight.localChanges ? ` Disclose these excluded local changes in the report:\n${preflight.localChanges}` : " The registered checkout has no local changes to exclude."}\nYou may make scratch edits or commits only in this disposable worktree. They will never be delivered. Write the authoritative, non-empty standalone Markdown report to ${reportPath}. Cover the investigation, findings, evidence, recommendations, and unresolved decisions as useful without fixed headings. Return a concise terminal conclusion. Unresolved decisions do not block completion. Complete this assignment directly; do not delegate to subagents. Do not implement changes for delivery.\n\n${item.task}`
					: `${context}\n\nThis is a project-independent scout. No registered-project checkout or project revision applies, and project-specific context is intentionally excluded. Global and user OMP instructions still apply. Scratch files in ${directory} are disposable and are never delivered; do not create commits. Public web search and reads of public URLs are enabled by default. Access authenticated external systems only when this assignment explicitly instructs it. Write the authoritative, non-empty standalone Markdown report to ${reportPath}. Include source URLs and the research date. Cover the investigation, findings, evidence, recommendations, and unresolved decisions as useful without fixed headings. Return a concise terminal conclusion. Unresolved decisions do not block completion. Complete this assignment directly; do not delegate to subagents. Do not implement changes for delivery.\n\n${item.task}`;
			await this.context.prompt(paneId, prompt, signal);
			const agent = await this.context.agent(paneId, signal);
			if (agent.identity !== "omp") throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
			const record: WorkerRecord = {
				scope: preflight.scope, kind: item.kind, name: item.name, role: item.role, status: agent.status === "blocked" ? "blocked" : "working",
				workspace_id: preflight.workspace, tab_id: tabId, pane_id: paneId,
				...(preflight.scope === "project"
					? { project: preflight.project, projectPath: preflight.projectPath, worktree: directory, lease_id: lease!.lease_id, lease_holder: lease!.lease_holder, delivery_base: preflight.head, branch: preflight.branch, push_to: item.pushTo, local_changes: item.kind === "scout" ? preflight.localChanges : undefined }
					: { working_directory: directory }),
				report_path: reportPath, generation: 0,
			};
			this.workers.adopt(record, agent.status);
			return this.workers.publicRecord(record);
		} catch (error) {
			const message = errorMessage(error);
			if (!ompMayHaveStarted) {
				if (tabId) await this.context.bestEffort("herdr", ["tab", "close", tabId], signal);
				if (lease) await this.context.bestEffort("treehouse", ["return", "--force", "--if-lease-id", lease.lease_id, "--if-lease-holder", lease.lease_holder, lease.path], signal);
				else if (directory) {
					try { await rm(directory, { recursive: true }); } catch (cleanupError) { this.context.deps.logger.warn?.("Visible worker cleanup failed", { directory, error: errorMessage(cleanupError) }); }
				}
			} else if (directory && tabId && paneId) {
				const record: WorkerRecord = {
					scope: preflight.scope, kind: item.kind, name: item.name, role: item.role, status: "failed", workspace_id: preflight.workspace, tab_id: tabId, pane_id: paneId,
					...(preflight.scope === "project"
						? { project: preflight.project, projectPath: preflight.projectPath, worktree: directory, lease_id: lease!.lease_id, lease_holder: lease!.lease_holder, delivery_base: preflight.head, branch: preflight.branch, push_to: item.pushTo, local_changes: item.kind === "scout" ? preflight.localChanges : undefined }
						: { working_directory: directory }),
					report_path: reportPath, error: message, generation: 0,
				};
				this.context.workers.set(item.name, record);
				return this.workers.publicRecord(record);
			}
			return { kind: item.kind, ...(preflight.scope === "independent" ? { scope: "independent" } : { project: preflight.project, delivery_base: preflight.head }), name: item.name, ...(item.role ? { role: item.role } : {}), status: "failed", ...(directory ? preflight.scope === "independent" ? { working_directory: directory } : { worktree: directory, lease_id: lease?.lease_id } : {}), ...(tabId ? { workspace_id: preflight.workspace, tab_id: tabId } : {}), ...(paneId ? { pane_id: paneId } : {}), ...(item.pushTo ? { push_to: item.pushTo } : {}), ...(reportPath ? { report_path: reportPath, ...(preflight.scope === "project" ? { local_changes: preflight.localChanges } : {}) } : {}), error: message };
		}
	}
}

export function registerTaskTool(pi: ExtensionAPI, runtime: TaskRuntime): void {
	const { z } = pi.zod;
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
		execute: async (_id: string, params: TaskParams, signal?: AbortSignal) => runtime.run(params, signal),
	});
}
