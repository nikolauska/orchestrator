import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexUsage } from "../src/runtime/claude";
import { lastResponse } from "../src/runtime/session";
import type { RuntimeDeps } from "../src/runtime/shared";
import { FakeExec, runtime } from "./herdr-fixtures";
import { cleanup, eventually, fixtureRoot, register } from "./test-helpers";

afterEach(cleanup);

async function codexFixture() {
  const { root, project } = await fixtureRoot();
  const fake = new FakeExec(project);
  fake.agentIdentity = "codex";
  const messages: Array<{ message: string; options: unknown }> = [];
  const instance = runtime(root, fake, messages);
  await register(instance, project);
  return { root, project, fake, messages, instance };
}

function herdrCalls(fake: FakeExec, ...words: string[]): string[][] {
  return fake.calls
    .filter((call) => call.command === "herdr" && words.every((word) => call.args.includes(word)))
    .map((call) => call.args);
}

describe("Codex workers", () => {
  test("start in-pane, trust only their directory, and read the answer by directory", async () => {
    const { fake, messages, instance } = await codexFixture();
    const result = await instance.runTask({
      project: "fixture",
      context: "shared",
      tasks: [
        {
          kind: "implementation",
          name: "alpha",
          task: "A",
          agent: "codex",
          model: "gpt-6-sol:high",
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    const launched = (result.details as Array<Record<string, unknown>>)[0]!;
    expect(launched).toMatchObject({ agent: "codex", model: "gpt-6-sol", thinking: "high" });
    const directory = launched.worktree as string;
    const [start] = herdrCalls(fake, "agent", "start");
    expect(start!.slice(start!.indexOf("--"))).toEqual([
      "--",
      "--disable",
      "daemon_auto_start",
      "-C",
      directory,
      "-c",
      `projects={${JSON.stringify(directory)}={trust_level="trusted"}}`,
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-6-sol",
      "-c",
      'model_reasoning_effort="high"',
    ]);
    expect(fake.calls.some((call) => call.command === "omp" && call.args[0] === "models")).toBe(
      false,
    );
    fake.settle("alpha");
    await eventually(() => expect(messages.length).toBe(1));
    expect(messages[0]!.message).toContain('"status": "merged"');
    expect(messages[0]!.message).toContain("output pane:alpha");
  });

  test("attach remote-control workers to the app server and set CODEX_HOME first", async () => {
    const { project, fake, instance } = await codexFixture();
    const result = await instance.runTask({
      project: "fixture",
      context: "shared",
      tasks: [
        {
          kind: "scout",
          name: "remote",
          task: "R",
          agent: "codex",
          remoteControl: true,
          codexHome: project,
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toContainEqual(
      expect.objectContaining({ name: "remote", remote_control: true, codex_home: project }),
    );
    const [run] = herdrCalls(fake, "pane", "run");
    expect(run!.at(-1)).toBe(`export CODEX_HOME='${project}'`);
    const [start] = herdrCalls(fake, "agent", "start");
    expect(start).toContain("--remote");
    expect(start).not.toContain("daemon_auto_start");
  });

  test("confirm Codex's folder trust prompt once and keep launching", async () => {
    const { fake, instance } = await codexFixture();
    fake.codexTrustPromptOnce = true;
    const result = await instance.runTask({
      project: "fixture",
      context: "shared",
      tasks: [{ kind: "scout", name: "look", task: "L", agent: "codex" }],
    });
    expect(result.isError).toBeUndefined();
    expect(herdrCalls(fake, "agent", "send-keys", "enter")).toHaveLength(1);
  });

  test("refuse roles, malformed models and Codex homes on other workers", async () => {
    const { instance } = await codexFixture();
    const run = (item: Record<string, unknown>) =>
      instance.runTask({
        project: "fixture",
        context: "shared",
        tasks: [{ kind: "implementation", name: "alpha", task: "A", ...item }],
      } as never);
    expect((await run({ agent: "codex", role: "slow" })).isError).toBe(true);
    expect((await run({ agent: "codex", model: "gpt-6-sol:extreme" })).isError).toBe(true);
    expect((await run({ agent: "codex", codexHome: "relative/home" })).isError).toBe(true);
    expect((await run({ agent: "claude", codexHome: "/tmp" })).isError).toBe(true);
  });
});

describe("Codex sessions, quota and models", () => {
  test("skip newer subagent and other-directory sessions when reading the answer", async () => {
    const { root, fake, messages, instance } = await codexFixture();
    const result = await instance.runTask({
      project: "fixture",
      context: "shared",
      tasks: [{ kind: "implementation", name: "alpha", task: "A", agent: "codex" }],
    });
    const directory = (result.details as Array<Record<string, unknown>>)[0]!.worktree as string;
    const folder = join(root, "codex-sessions", "2026", "10", "16");
    await mkdir(folder, { recursive: true });
    const session = (name: string, meta: Record<string, unknown>, answer: string) =>
      writeFile(
        join(folder, name),
        [
          { type: "session_meta", payload: meta },
          { type: "event_msg", payload: { type: "task_complete", last_agent_message: answer } },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
    await session(
      "rollout-2026-10-16T23-00-00-sub.jsonl",
      { cwd: directory, thread_source: "subagent" },
      "subagent",
    );
    await session(
      "rollout-2026-10-16T23-00-01-other.jsonl",
      { cwd: `${directory}-other` },
      "other",
    );
    fake.settle("alpha");
    await eventually(() => expect(messages.length).toBe(1));
    expect(messages[0]!.message).toContain("output pane:alpha");
    expect(messages[0]!.message).not.toContain("subagent");
  });

  test("read the last finished turn of a Codex session", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "rollout.jsonl");
    await writeFile(
      path,
      [
        { type: "session_meta", payload: { cwd: root } },
        { type: "event_msg", payload: { type: "task_complete", last_agent_message: "first" } },
        { type: "response_item", payload: { type: "message", role: "assistant" } },
        { type: "event_msg", payload: { type: "task_complete", last_agent_message: "final" } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    expect(await lastResponse(path)).toBe("final");
  });

  test("read Codex quota under a chosen Codex home without a shell", async () => {
    const calls: string[][] = [];
    const deps = {
      exec: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({
            providers: [
              {
                provider: "codex",
                plan: "team",
                windows: [{ id: "weekly", percentRemaining: 80, resetsAt: "2026-10-20T00:00:00Z" }],
                state: { status: "fresh" },
              },
            ],
          }),
        };
      },
    } as unknown as RuntimeDeps;
    const usage = await codexUsage(
      deps,
      Date.parse("2026-10-16T00:00:00Z"),
      undefined,
      "/work/codex",
    );
    expect(calls[0]!.slice(0, 3)).toEqual(["env", "CODEX_HOME=/work/codex", "bun"]);
    expect(calls[0]).toContain("codex");
    expect(usage).toMatchObject({
      plan: "team",
      windows: [{ window: "weekly", remaining_percent: 80, window_elapsed_percent: 43 }],
    });
  });

  test("list cached Codex models and save Codex preferences by shape", async () => {
    const { instance } = await codexFixture();
    const home = await mkdtemp(join(tmpdir(), "codex-home-"));
    await writeFile(
      join(home, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-6-sol",
            display_name: "GPT-6-Sol",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
          },
          { slug: "internal", visibility: "hide" },
        ],
      }),
    );
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(
        (
          await instance.runModels({
            op: "prefer",
            agent: "codex",
            model: "gpt-6-sol:high",
            rank: 1,
          })
        ).isError,
      ).toBeUndefined();
      expect(
        (await instance.runModels({ op: "prefer", agent: "codex", model: "gpt/6:huge" })).isError,
      ).toBe(true);
      const listed = (await instance.runModels({ op: "list", view: "all", provider: "codex-cli" }))
        .details as {
        models: Array<Record<string, unknown>>;
      };
      expect(listed.models.map((row) => row.model)).toEqual(["gpt-6-sol:high", "gpt-6-sol"]);
      expect(listed.models[1]).toMatchObject({ agent: "codex", thinking_levels: ["low", "ultra"] });
    } finally {
      process.env.CODEX_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});
