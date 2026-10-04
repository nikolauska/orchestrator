import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { ToolAPI } from "../../runtime/shared";
import { resolveMachineOmpContext } from "../../runtime/machines";
import { stateFor } from "./workers";
import modelsTool from "./models";
import machinesTool from "./machines";
import taskTool from "./orchestrator_task";
import projectsTool from "./projects";
import reportsTool from "./reports";
import usageTool from "./usage";
import workersTool from "./workers";

// Tools register through an extension because only ExtensionAPI.sendMessage can trigger a
// root turn; the custom tool API has no wake path, so worker completions would only toast.
export function registerOrchestrator(
  pi: ExtensionAPI,
  services: Pick<ToolAPI, "localHostRuntime" | "spawnStdio"> = {},
): ToolAPI {
  // One shared object: worker state is keyed by it, so orchestrator_task and workers must see the same instance.
  const api: ToolAPI = {
    ...services,
    cwd: process.cwd(),
    exec: pi.exec.bind(pi),
    logger: pi.logger,
    zod: pi.zod,
    sendMessage: pi.sendMessage.bind(pi),
  };
  api.resolveOmpContext = (machine, signal) =>
    resolveMachineOmpContext(api, machine, {
      controllerId: stateFor(api).store.controllerId,
      signal,
    });
  for (const factory of [
    projectsTool,
    machinesTool,
    taskTool,
    workersTool,
    reportsTool,
    usageTool,
    modelsTool,
  ])
    pi.registerTool(factory(api));
  return api;
}
const orchestrator: ExtensionFactory = (pi) => {
  registerOrchestrator(pi);
};

export default orchestrator;
