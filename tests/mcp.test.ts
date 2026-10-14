import { afterEach, describe, expect, test } from "bun:test";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpOrchestrator, inputSchema, serveMcp } from "../src/adapters/mcp";
import { notify, stateFor } from "../src/tools/workers";
import { cleanup, eventually, fixtureRoot } from "./test-helpers";

afterEach(cleanup);

async function connected() {
  const { root } = await fixtureRoot();
  const orchestrator = createMcpOrchestrator(
    { cwd: root, exec: async () => ({ stdout: "", stderr: "", code: 1 }), logger: {} },
    zod,
  );
  const state = stateFor(orchestrator.api);
  const channel: string[] = [];
  const client = new Client({ name: "test", version: "1.0.0" });
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === "notifications/claude/channel")
      channel.push((notification.params as { content: string }).content);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return {
    orchestrator,
    state,
    channel,
    client,
    start: async () => {
      await serveMcp(orchestrator, serverTransport);
      await client.connect(clientTransport);
    },
    close: async () => {
      await client.close();
      state.store.close();
    },
  };
}

describe("MCP adapter", () => {
  test("lists every tool with a top-level object schema", async () => {
    const fixture = await connected();
    await fixture.start();
    try {
      const { tools } = await fixture.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "machines",
        "models",
        "orchestrator_task",
        "projects",
        "reports",
        "usage",
        "workers",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema).not.toHaveProperty("anyOf");
      }
      const workers = tools.find((tool) => tool.name === "workers")!;
      expect(
        (workers.inputSchema.properties as Record<string, { enum?: string[] }>).op!.enum,
      ).toEqual(["list", "events", "read", "send", "interrupt", "relaunch", "land", "close"]);
      expect(workers.inputSchema.required).toEqual(["op"]);
      expect(tools.find((tool) => tool.name === "reports")!.annotations?.readOnlyHint).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  test("validates arguments against the tool's own schema", async () => {
    const fixture = await connected();
    await fixture.start();
    try {
      const invalid = await fixture.client.callTool({
        name: "workers",
        arguments: { op: "events", names: ["alpha"] },
      });
      expect(invalid.isError).toBe(true);
      const unknown = await fixture.client.callTool({ name: "hub", arguments: {} });
      expect(unknown.isError).toBe(true);
      const events = await fixture.client.callTool({
        name: "workers",
        arguments: { op: "events" },
      });
      expect(events.isError).toBeUndefined();
      expect((events.content as Array<{ text: string }>)[0]!.text).toStartWith(
        "Pending supervisor events:",
      );
    } finally {
      await fixture.close();
    }
  });

  test("sends events recorded before connection as channel notifications", async () => {
    const fixture = await connected();
    // Recorded while no client is connected, as when a worker settles between sessions.
    fixture.state.store.recordEvent("alpha", "Visible worker result:\n{}");
    await fixture.start();
    try {
      await eventually(() => expect(fixture.channel).toEqual(["Visible worker result:\n{}"]));
      await eventually(() => expect(fixture.state.store.pendingEvents()).toEqual([]));
      notify(fixture.state, { name: "beta", status: "failed" });
      await eventually(() => expect(fixture.channel).toHaveLength(2));
      expect(fixture.channel[1]).toContain('"name": "beta"');
      await eventually(() => expect(fixture.state.store.pendingEvents()).toEqual([]));
    } finally {
      await fixture.close();
    }
  });

  test("releases supervision when the client disconnects", async () => {
    const fixture = await connected();
    await fixture.start();
    await eventually(() => expect(fixture.state.store.owner()?.token).toBe(fixture.state.token));
    await fixture.client.close();
    await eventually(() => expect(fixture.state.store.owner()).toBeUndefined());
    fixture.state.store.close();
  });
});

describe("input schema flattening", () => {
  test("merges op variants, keeps differing shapes as alternatives and only shared requirements", () => {
    const schema = zod.union([
      zod.object({ op: zod.literal("a"), name: zod.string() }).strict(),
      zod
        .object({ op: zod.literal("b"), name: zod.number(), extra: zod.boolean().optional() })
        .strict(),
    ]);
    expect(inputSchema(schema)).toEqual({
      type: "object",
      properties: {
        op: { enum: ["a", "b"], type: "string" },
        name: { anyOf: [{ type: "string" }, { type: "number" }] },
        extra: { type: "boolean" },
      },
      required: ["op", "name"],
      additionalProperties: false,
    });
  });
});
