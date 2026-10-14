import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_WORKER_SETTINGS } from "../src/runtime/herdr";
import { lastResponse } from "../src/runtime/session";
import { WorkerStore } from "../src/runtime/store";
import { FakeExec, runtime } from "./herdr-fixtures";
import { cleanup, eventually, fixtureRoot, register } from "./test-helpers";

afterEach(cleanup);

const WITH_CLAUDE = "omp: current (v10) (host overlay)\nclaude: current (v4) (hooks)";

async function claudeFixture(integrationStatus = WITH_CLAUDE) {
  const { root, project } = await fixtureRoot();
  const fake = new FakeExec(project);
  fake.agentIdentity = "claude";
  fake.integrationStatus = integrationStatus;
  const messages: Array<{ message: string; options: unknown }> = [];
  const instance = runtime(root, fake, messages);
  await register(instance, project);
  return { root, project, fake, messages, instance };
}

function agentStarts(fake: FakeExec): string[][] {
  return fake.calls
    .filter((call) => call.command === "herdr" && call.args.includes("start"))
    .map((call) => call.args);
}

describe("Claude Code workers", () => {
  test("start through Herdr's claude kind with the approved settings and deliver", async () => {
    const { fake, messages, instance } = await claudeFixture();
    const result = await instance.runTask({
      project: "fixture",
      context: "shared",
      tasks: [
        { kind: "implementation", name: "alpha", task: "A", agent: "claude", model: "opus:high" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect((result.details as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "alpha",
      agent: "claude",
      model: "opus",
      thinking: "high",
    });
    const [start] = agentStarts(fake);
    expect(start!.slice(start!.indexOf("--kind"), start!.indexOf("--kind") + 2)).toEqual([
      "--kind",
      "claude",
    ]);
    expect(start!.slice(start!.indexOf("--"))).toEqual([
      "--",
      "--settings",
      CLAUDE_WORKER_SETTINGS,
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
    // A Claude-only batch never consults OMP's catalog or roles.
    expect(fake.calls.some((call) => call.command === "omp" && call.args[0] === "models")).toBe(
      false,
    );
    fake.settle("alpha");
    await eventually(() => expect(messages.length).toBe(1));
    expect(messages[0]!.message).toContain('"status": "merged"');
  });

  test("keep the host's default model when none is named", async () => {
    const { fake, instance } = await claudeFixture();
    const result = await instance.runTask({
      project: "fixture",
      context: "shared",
      tasks: [{ kind: "scout", name: "look", task: "Investigate", agent: "claude" }],
    });
    expect(result.isError).toBeUndefined();
    const [start] = agentStarts(fake);
    expect(start!.slice(start!.indexOf("--"))).toEqual([
      "--",
      "--settings",
      CLAUDE_WORKER_SETTINGS,
    ]);
  });

  test("require Herdr's Claude integration before allocating anything", async () => {
    const { fake, instance } = await claudeFixture("omp: current (v10) (host overlay)");
    const result = await instance.runTask({
      project: "fixture",
      context: "shared",
      tasks: [{ kind: "implementation", name: "alpha", task: "A", agent: "claude" }],
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "herdr integration install claude",
    );
    expect(agentStarts(fake)).toEqual([]);
    expect(fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "get")).toBe(
      false,
    );
  });

  test("refuse OMP roles and malformed models", async () => {
    const { instance } = await claudeFixture();
    const run = (item: Record<string, unknown>) =>
      instance.runTask({
        project: "fixture",
        context: "shared",
        tasks: [{ kind: "implementation", name: "alpha", task: "A", agent: "claude", ...item }],
      } as never);
    expect((await run({ role: "slow" })).isError).toBe(true);
    expect((await run({ model: "opus:extreme" })).isError).toBe(true);
    expect((await run({ model: "anthropic/claude-opus" })).isError).toBe(true);
  });
});

describe("Claude Code transcripts", () => {
  test("return the last main-thread assistant message, joining its text blocks", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "transcript.jsonl");
    const line = (value: unknown) => JSON.stringify(value);
    await writeFile(
      path,
      [
        line({
          type: "assistant",
          message: { id: "m1", role: "assistant", content: [{ type: "text", text: "early" }] },
        }),
        line({ type: "user", message: { role: "user", content: "next" } }),
        line({
          type: "assistant",
          message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Done." }] },
        }),
        line({
          type: "assistant",
          message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t" }] },
        }),
        line({
          type: "assistant",
          message: {
            id: "m2",
            role: "assistant",
            content: [{ type: "text", text: "Report written." }],
          },
        }),
        line({
          isSidechain: true,
          type: "assistant",
          message: { id: "s", role: "assistant", content: [{ type: "text", text: "subagent" }] },
        }),
        '{"type":"assistant","message":{"id":"m3"',
      ].join("\n"),
    );
    expect(await lastResponse(path)).toBe("Done.\n\nReport written.");
  });

  test("still read OMP sessions", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "first" }] },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "final" }] },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "toolCall" }] },
        }),
      ].join("\n"),
    );
    expect(await lastResponse(path)).toBe("final");
  });
});

describe("agent kind storage", () => {
  test("adds the agent kind column to an existing database", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "kind.db");
    new WorkerStore(path).close();
    const db = new Database(path);
    db.run("ALTER TABLE workers DROP COLUMN agent_kind");
    db.close();
    const store = new WorkerStore(path);
    const columns = (
      new Database(path).query("PRAGMA table_info(workers)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toContain("agent_kind");
    store.close();
  });
});
