import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { errorMessage, NAME, text, type ProjectParams, type ToolResult, WorkerContext } from "./shared";

export class ProjectsRuntime {
	constructor(readonly context: WorkerContext) {}

	async run(params: ProjectParams, signal?: AbortSignal): Promise<ToolResult> {
		this.context.active = true;
		try {
			const projects = await this.read();
			if (params.op === "list") return this.#result(projects);
			if (params.op === "set-root") return this.#rootResult(await this.#writeRoot(params.path));
			this.validateName(params.name, "project");
			if (params.op === "remove") {
				if (!(params.name in projects)) throw new Error(`Unknown registered project: ${params.name}`);
				delete projects[params.name];
				await this.#write(projects);
				return this.#result(projects);
			}
			if (params.op === "create") {
				if (projects[params.name]) throw new Error(`Project name already registered: ${params.name}`);
				const target = params.path ? await this.#newPath(params.path) : join(await this.#readRoot(), params.name);
				const other = Object.entries(projects).find(([, path]) => path === target);
				if (other) throw new Error(`Project path already registered as ${other[0]}`);
				await mkdir(target);
				await this.context.run("git", ["init"], { cwd: target, signal });
				projects[params.name] = target;
				await this.#write(projects);
				return this.#result(projects);
			}
			const canonical = await this.#directory(params.path, "Project path");
			const top = await this.context.run("git", ["rev-parse", "--show-toplevel"], { cwd: canonical, signal });
			const gitRoot = await realpath(top.trim());
			if (gitRoot !== canonical) throw new Error(`Path is not an exact Git root: ${canonical}`);
			if (projects[params.name] && projects[params.name] !== canonical) throw new Error(`Project name already registered: ${params.name}`);
			const other = Object.entries(projects).find(([name, path]) => name !== params.name && path === canonical);
			if (other) throw new Error(`Project path already registered as ${other[0]}`);
			if (projects[params.name] !== canonical) {
				projects[params.name] = canonical;
				await this.#write(projects);
			}
			return this.#result(projects);
		} catch (error) {
			return text(errorMessage(error), undefined, true);
		}
	}

	async read(): Promise<Record<string, string>> {
		let raw: string;
		try {
			raw = await readFile(join(this.context.root, ".omp", "projects.json"), "utf8");
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

	validateName(name: string, kind: string): void {
		if (typeof name !== "string" || !NAME.test(name)) throw new Error(`Invalid ${kind} name: ${name}`);
	}
	async #directory(path: string, kind: string): Promise<string> {
		const input = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
		if (!isAbsolute(input)) throw new Error(`${kind} must be absolute or start with ~/`);
		const canonical = await realpath(input);
		if (!(await stat(canonical)).isDirectory()) throw new Error(`${kind} must be a directory: ${canonical}`);
		return canonical;
	}

	async #newPath(path: string): Promise<string> {
		const input = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
		if (!isAbsolute(input)) throw new Error("Project path must be absolute or start with ~/");
		return join(await realpath(dirname(input)), basename(input));
	}

	async #readRoot(): Promise<string> {
		let root: string;
		try {
			root = (await readFile(join(this.context.root, ".omp", "projects-root"), "utf8")).trim();
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("No projects root configured; use projects.set-root first");
			throw error;
		}
		if (!root) throw new Error("Malformed .omp/projects-root");
		return this.#directory(root, "Configured projects root");
	}

	async #writeRoot(path: string): Promise<string> {
		const canonical = await this.#directory(path, "Projects root");
		const destination = join(this.context.root, ".omp", "projects-root");
		await mkdir(dirname(destination), { recursive: true });
		const temp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await writeFile(temp, `${canonical}\n`, { flag: "wx" });
		await rename(temp, destination);
		return canonical;
	}

	#rootResult(path: string): ToolResult {
		return text(`Projects root: ${path}`, { path });
	}


	async #write(projects: Record<string, string>): Promise<void> {
		const path = join(this.context.root, ".omp", "projects.json");
		await mkdir(dirname(path), { recursive: true });
		const sorted = Object.fromEntries(Object.entries(projects).sort(([a], [b]) => a.localeCompare(b)));
		const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx" });
		await rename(temp, path);
	}


	#result(projects: Record<string, string>): ToolResult {
		const items = Object.entries(projects).sort(([a], [b]) => a.localeCompare(b)).map(([name, path]) => ({ name, path }));
		return text(`Registered projects:\n${JSON.stringify(items, null, 2)}`, items);
	}
}

export function registerProjectsTool(pi: ExtensionAPI, runtime: ProjectsRuntime): void {
	const { z } = pi.zod;
	pi.registerTool({
		name: "projects", label: "Projects", loadMode: "essential", approval: "write",
		description: "Create, register, and manage local Git projects used by visible worker tasks. Configure a projects root before creating at the default destination. Removal unregisters only; it never deletes a repository.",
		parameters: z.discriminatedUnion("op", [z.object({ op: z.literal("list") }), z.object({ op: z.literal("add"), name: z.string(), path: z.string() }), z.object({ op: z.literal("create"), name: z.string(), path: z.string().optional() }), z.object({ op: z.literal("remove"), name: z.string() }), z.object({ op: z.literal("set-root"), path: z.string() })]),
		execute: async (_id: string, params: ProjectParams, signal?: AbortSignal) => runtime.run(params, signal),
	});
}
