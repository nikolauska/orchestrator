import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ToolSpec } from "../core/tool";
import type { ToolAPI } from "../runtime/shared";
import { createTools } from "../tools";

export function ompTool(spec: ToolSpec): ToolDefinition<any, any> {
  const { execute, onSession, ...definition } = spec;
  return {
    ...definition,
    loadMode: "essential",
    execute: (_id: string, params: unknown, signal?: AbortSignal) => execute(params, signal),
    ...(onSession ? { onSession: (event) => onSession(event.reason) } : {}),
  };
}

// Tools register through an extension because only ExtensionAPI.sendMessage can trigger a
// root turn; the custom tool API has no wake path, so worker completions would only toast.
export function registerOrchestrator(
  pi: ExtensionAPI,
  services: Pick<ToolAPI, "localHostRuntime" | "spawnStdio"> = {},
): ToolAPI {
  const api: ToolAPI = {
    ...services,
    cwd: process.cwd(),
    exec: pi.exec.bind(pi),
    logger: pi.logger,
    zod: pi.zod,
    notify: (message) => pi.sendMessage(message, { triggerTurn: true, deliverAs: "nextTurn" }),
  };
  for (const spec of createTools(api)) pi.registerTool(ompTool(spec));
  return api;
}

const orchestrator: ExtensionFactory = (pi) => {
  registerOrchestrator(pi);
};

export default orchestrator;
