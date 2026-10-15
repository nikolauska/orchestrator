import { isDeepStrictEqual } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Schema, ToolSpec } from "../core/tool";
import type { ToolAPI } from "../runtime/shared";
import { createTools } from "../tools";

export const SERVER_NAME = "orchestrator";

const INSTRUCTIONS = `This server provides the orchestrator tools that AGENTS.md names without a prefix: projects, machines, orchestrator_task, workers, reports, usage and models.
Worker results, blocked questions and notices arrive as <channel source="${SERVER_NAME}"> events; they take the place of the nextTurn messages AGENTS.md describes. Handle each one as AGENTS.md says for that kind of result.
Events are pushed only when this session was started with the orchestrator channel enabled. Otherwise nothing wakes the session: tell the user, and read pending results with workers op "events".
When this session is itself a Remote Control session (the user can follow it from another device; CLAUDE_CODE_BRIDGE_SESSION_ID is set in your Bash environment), launch Claude Code workers with remoteControl: true unless the user says otherwise, so they can follow those workers the same way.`;

type JsonObject = Record<string, unknown>;

/**
 * Claude's tool API refuses a top-level anyOf, so op-keyed unions are merged into one object
 * whose properties list every variant. The tool's own schema still validates each call.
 */
export function inputSchema(schema: Schema): JsonObject {
  const document = schema.toJsonSchema() as JsonObject;
  delete document.$schema;
  const branches = document.anyOf as JsonObject[] | undefined;
  if (!branches) return { type: "object", ...document };
  const variants = new Map<string, unknown[]>();
  let required: string[] | undefined;
  for (const branch of branches) {
    if (branch.type !== "object") throw new Error("Tool parameters must be objects");
    for (const [key, value] of Object.entries((branch.properties ?? {}) as JsonObject)) {
      const seen = variants.get(key) ?? [];
      if (!seen.some((item) => isDeepStrictEqual(item, value))) seen.push(value);
      variants.set(key, seen);
    }
    const branchRequired = (branch.required ?? []) as string[];
    required = required
      ? required.filter((key) => branchRequired.includes(key))
      : [...branchRequired];
  }
  const properties: JsonObject = {};
  for (const [key, seen] of variants) {
    const constants = seen.map((item) => (item as JsonObject).const);
    properties[key] =
      seen.length === 1
        ? seen[0]
        : seen.every((item) => Object.keys(item as JsonObject).join() === "const")
          ? {
              enum: constants,
              ...(constants.every((value) => typeof value === "string") ? { type: "string" } : {}),
            }
          : { anyOf: seen };
  }
  return {
    type: "object",
    properties,
    ...(required?.length ? { required } : {}),
    additionalProperties: false,
  };
}

async function callTool(
  spec: ToolSpec,
  args: unknown,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const parsed = spec.parameters.safeParse(args ?? {});
  if (!parsed.success)
    return {
      content: [{ type: "text", text: `Invalid ${spec.name} arguments: ${parsed.error.message}` }],
      isError: true,
    };
  const outcome = await spec.execute(parsed.data, signal);
  return { content: outcome.content, ...(outcome.isError ? { isError: true } : {}) };
}

export type McpOrchestrator = { server: Server; api: ToolAPI; shutdown(): void };

/**
 * Serves the tools over MCP. Supervisor events become Claude Code channel notifications, which
 * wake an idle session; Claude Code does not acknowledge them, so acceptance means written.
 */
export function createMcpOrchestrator(
  services: Omit<ToolAPI, "zod" | "notify">,
  zod: ToolAPI["zod"],
): McpOrchestrator {
  const server = new Server(
    { name: SERVER_NAME, version: "1.0.0" },
    {
      capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions: INSTRUCTIONS,
    },
  );
  const api: ToolAPI = {
    ...services,
    zod,
    notify: (message) =>
      server.notification({
        method: "notifications/claude/channel",
        params: { content: message },
      }),
  };
  const specs = createTools(api);
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((spec) => ({
      name: spec.name,
      title: spec.label,
      description: spec.description,
      inputSchema: inputSchema(spec.parameters) as { type: "object" },
      annotations: { title: spec.label, readOnlyHint: spec.approval === "read" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const spec = byName.get(request.params.name);
    if (!spec)
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    return callTool(spec, request.params.arguments, extra.signal);
  });
  // Pending events can only be sent once the client has finished the handshake.
  server.oninitialized = () => {
    for (const spec of specs) spec.onSession?.("start");
  };
  let stopped = false;
  return {
    server,
    api,
    shutdown: () => {
      if (stopped) return;
      stopped = true;
      for (const spec of specs) spec.onSession?.("shutdown");
    },
  };
}

export async function serveMcp(orchestrator: McpOrchestrator, transport: Transport): Promise<void> {
  // connect() takes over transport.onclose and forwards it to the server's.
  orchestrator.server.onclose = () => orchestrator.shutdown();
  await orchestrator.server.connect(transport);
}
