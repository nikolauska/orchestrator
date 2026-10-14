// Stdio entry Claude Code spawns from mcp/claude-code.json; stdout carries only JSON-RPC.
import { fileURLToPath } from "node:url";
import * as zod from "@oh-my-pi/omptype/zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { nativeExec } from "../runtime/host";
import { createMcpOrchestrator, serveMcp } from "./mcp";

// State lives in this repository's .omp directory whatever directory the client starts us in.
const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");
const orchestrator = createMcpOrchestrator(
  {
    cwd: root,
    exec: nativeExec,
    logger: {
      warn: (message, context) => console.error(message, context ? JSON.stringify(context) : ""),
    },
  },
  zod,
);
const stop = () => {
  orchestrator.shutdown();
  process.exit(0);
};
process.stdin.on("end", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await serveMcp(orchestrator, new StdioServerTransport());
