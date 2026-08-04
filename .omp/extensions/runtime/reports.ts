import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { errorMessage, NAME, text, type ReportsParams, type ToolResult, WorkerContext } from "./shared";

type Report = { namespace: string; path: string; modified_at: string };

export class ReportsRuntime {
	constructor(readonly context: WorkerContext) {}

	async run(params: ReportsParams, signal?: AbortSignal): Promise<ToolResult> {
		try {
			if (params.op === "list") return await this.#list(params.project, signal);
			return await this.#get(params.path);
		} catch (error) {
			return text(errorMessage(error), undefined, true);
		}
	}

	async #list(project: string | undefined, signal?: AbortSignal): Promise<ToolResult> {
		if (project !== undefined && project !== "_independent" && !NAME.test(project)) throw new Error(`Invalid report namespace: ${project}`);
		const root = join(this.context.root, ".omp", "reports");
		let namespaces;
		try {
			namespaces = await readdir(root, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return text("Reports:\n[]", []);
			throw error;
		}
		const reports = (await Promise.all(namespaces.filter(entry => entry.isDirectory() && (!project || entry.name === project)).map(async entry => {
			const directory = join(root, entry.name);
			const entries = await readdir(directory, { withFileTypes: true });
			return Promise.all(entries.filter(file => file.isFile() && file.name.endsWith(".md")).map(async file => {
				const path = join(directory, file.name);
				const info = await lstat(path);
				return { namespace: entry.name, path, modified_at: info.mtime.toISOString(), mtime: info.mtimeMs };
			}));
		}))).flat().sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path)).map(({ mtime: _mtime, ...report }) => report);
		return text(`Reports:\n${JSON.stringify(reports, null, 2)}`, reports);
	}

	async #get(path: string): Promise<ToolResult> {
		if (!isAbsolute(path)) throw new Error("Report path must be absolute");
		const root = await realpath(join(this.context.root, ".omp", "reports"));
		const target = await realpath(path);
		const location = relative(root, target);
		if (!location || location.startsWith("..") || isAbsolute(location)) throw new Error("Report path must be under .omp/reports");
		const info = await lstat(target);
		if (!info.isFile() || !target.endsWith(".md")) throw new Error("Report path must name a Markdown file");
		return text(await readFile(target, "utf8"), { path: target });
	}
}

export function registerReportsTool(pi: ExtensionAPI, runtime: ReportsRuntime): void {
	const { z } = pi.zod;
	pi.registerTool({
		name: "reports", label: "Reports", loadMode: "essential", approval: "read",
		description: "Find durable scout reports across registered projects and independent research, then read a selected report.",
		parameters: z.union([z.object({ op: z.literal("list"), project: z.string().optional() }).strict(), z.object({ op: z.literal("get"), path: z.string() }).strict()]),
		execute: async (_id: string, params: ReportsParams, signal?: AbortSignal) => runtime.run(params, signal),
	});
}
