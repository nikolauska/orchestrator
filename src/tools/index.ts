import type { ToolSpec } from "../core/tool";
import { resolveMachineOmpContext } from "../runtime/machines";
import type { ToolAPI } from "../runtime/shared";
import machinesTool from "./machines";
import modelsTool from "./models";
import taskTool from "./orchestrator_task";
import projectsTool from "./projects";
import reportsTool from "./reports";
import usageTool from "./usage";
import workersTool from "./workers";
import { stateFor } from "./workers";

/** Builds every orchestrator tool around one shared API object; worker state is keyed by it. */
export function createTools(api: ToolAPI): ToolSpec[] {
  api.resolveOmpContext ??= (machine, signal) =>
    resolveMachineOmpContext(api, machine, {
      controllerId: stateFor(api).store.controllerId,
      signal,
    });
  return [
    projectsTool,
    machinesTool,
    taskTool,
    workersTool,
    reportsTool,
    usageTool,
    modelsTool,
  ].map((factory) => factory(api));
}
