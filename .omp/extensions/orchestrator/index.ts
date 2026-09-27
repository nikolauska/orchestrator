import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { ToolAPI } from "../../runtime/shared";
import taskTool from "./orchestrator_task";
import projectsTool from "./projects";
import reportsTool from "./reports";
import workersTool from "./workers";

// Tools register through an extension because only ExtensionAPI.sendMessage can trigger a
// root turn; the custom tool API has no wake path, so worker completions would only toast.
const orchestrator: ExtensionFactory = (pi) => {
  // One shared object: worker state is keyed by it, so orchestrator_task and workers must see the same instance.
  const api: ToolAPI = {
    cwd: process.cwd(),
    exec: pi.exec.bind(pi),
    logger: pi.logger,
    zod: pi.zod,
    sendMessage: pi.sendMessage.bind(pi),
  };
  for (const factory of [projectsTool, taskTool, workersTool, reportsTool])
    pi.registerTool(factory(api));
};

export default orchestrator;
