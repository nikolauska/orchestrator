import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ProjectsRuntime, registerProjectsTool } from "./runtime/projects";
import { WorkerContext, type ExecResult, type ProjectParams, type RuntimeDeps, type TaskParams, type ToolResult, type WorkersParams } from "./runtime/shared";
import { TaskRuntime, registerTaskTool } from "./runtime/task";
import { WorkersRuntime, registerWorkersTool } from "./runtime/workers";

export type { ExecResult, RuntimeDeps } from "./runtime/shared";

export class VisibleWorkerRuntime {
	readonly projects: ProjectsRuntime;
	readonly task: TaskRuntime;
	readonly workers: WorkersRuntime;

	constructor(deps: RuntimeDeps, root = process.cwd(), env: Record<string, string | undefined> = process.env, neutralRoot?: string) {
		const context = new WorkerContext(deps, root, env, neutralRoot);
		this.projects = new ProjectsRuntime(context);
		this.workers = new WorkersRuntime(context);
		this.task = new TaskRuntime(context, this.projects, this.workers);
	}

	runProjects(params: ProjectParams, signal?: AbortSignal): Promise<ToolResult> {
		return this.projects.run(params, signal);
	}

	runTask(params: TaskParams, signal?: AbortSignal): Promise<ToolResult> {
		return this.task.run(params, signal);
	}

	runWorkers(params: WorkersParams, signal?: AbortSignal): Promise<ToolResult> {
		return this.workers.run(params, signal);
	}

	dispose(): void {
		this.workers.dispose();
	}
}

export default function visibleWorkersExtension(pi: ExtensionAPI): void {
	const runtime = new VisibleWorkerRuntime({ exec: pi.exec.bind(pi), sendMessage: pi.sendMessage.bind(pi), logger: pi.logger });
	registerProjectsTool(pi, runtime.projects);
	registerTaskTool(pi, runtime.task);
	registerWorkersTool(pi, runtime.workers);
	pi.on("session_switch", () => runtime.dispose());
	pi.on("session_shutdown", () => runtime.dispose());
}
