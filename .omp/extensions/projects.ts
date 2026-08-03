import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { errorMessage, NAME, text, type ProjectParams, type ToolResult, WorkerContext } from "./shared";

export class ProjectsRuntime {
	constructor(readonly context: WorkerContext) {}

	async run(params: ProjectParams, signal?: AbortSignal): Promise<ToolResult> {
		this.context.active = true;
		try {
			const projects = await this.read();
			if (params.op === "list") return this.#result(projects);
			this.validateName(params.name, "project");
			if (params.op === "remove") {
				if (!(params.name in projects)) throw new Error(`Unknown registered project: ${params.name}`);
				delete projects[params.name];
				await this.#write(projects);
				return this.#result(projects);
			}
			const input = params.path.startsWith("~/") ? join(homedir(), params.path.slice(2)) : params.path;
			if (!isAbsolute(input)) throw new Error("Project path must be absolute or start with ~/");
			const canonical = await realpath(input);
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
		description: "Manage registered local Git projects used by visible worker tasks. Removal unregisters only; it never deletes a repository.",
		parameters: z.discriminatedUnion("op", [z.object({ op: z.literal("list") }), z.object({ op: z.literal("add"), name: z.string(), path: z.string() }), z.object({ op: z.literal("remove"), name: z.string() })]),
		execute: async (_id: string, params: ProjectParams, signal?: AbortSignal) => runtime.run(params, signal),
	});
}
