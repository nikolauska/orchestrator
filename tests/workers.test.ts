import { afterEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { basename, join } from "node:path";
import { mkdir, writeFile, rm, readFile, symlink, lstat, readdir } from "node:fs/promises";
import { launchFixture } from "./task-fixtures";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getReport, listReports } from "../src/tools/reports";
import { collectReport, provenancePath } from "../src/runtime/report-transfer";
import { dispatchHostRequest, streamHostReport } from "../src/runtime/host";
import type { StdioSpawn, WorkerRecord } from "../src/runtime/shared";
import {
  stateFor,
  disposeWorkers,
  handleSession,
  notify,
  runWorkers,
  workerHostCall,
  recoverWorker,
  verifyWorkerAgent,
  refreshWorkerHost,
  type WorkerState,
} from "../src/tools/workers";
import { canonicalPath } from "../src/runtime/host-paths";
import type { ExecResult } from "../src/runtime/shared";
import { validateHostRequest } from "../src/runtime/helper-protocol";
import { cleanup, eventually, fixtureRoot, register } from "./test-helpers";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { ToolAPI } from "../src/runtime/shared";
import { FakeExec, runtime, extensionRuntime, launchedPair } from "./herdr-fixtures";

afterEach(cleanup);
describe("launch and control", () => {
  test("preflight failures acquire no resources", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const missing = runtime(root, fake, [], {});
    const unknown = await missing.runTask({
      project: "missing",
      context: "",
      tasks: [{ kind: "implementation", name: "one", task: "work" }],
    });
    expect(unknown.isError).toBe(true);
    await register(missing, project);
    expect(
      (
        await missing.runTask({
          project: "fixture",
          context: "",
          tasks: [{ kind: "implementation", name: "one", task: "work" }],
        })
      ).isError,
    ).toBe(true);
    expect(fake.workerHeads.size).toBe(0);
    expect(fake.workspaces).toEqual([]);
  });

  test("uses Herdr's managed process context without legacy session variables", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "implementation", name: "one", task: "work" }],
    });
    expect(result.isError).toBeUndefined();
    expect(fake.status.get("pane:one")).toBe("working");
  });

  test("nests project workers under one project space named after the registration", async () => {
    const { fake } = await launchedPair();
    expect(
      fake.workspaces
        .filter((item) => item.worktree && !item.worktree.is_linked_worktree)
        .map((item) => item.label),
    ).toEqual(["fixture"]);
    expect(
      fake.workspaces
        .filter((item) => item.worktree?.is_linked_worktree)
        .map((item) => item.label)
        .sort(),
    ).toEqual(["impl·alpha", "impl·beta"]);
  });

  test("keeps the name of a project space the user already had", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.workspaces.push({ workspace_id: "space-mine", label: "my checkout", cwd: project });
    const instance = runtime(root, fake, []);
    await register(instance, project);
    await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "scout", name: "look", task: "work" }],
    });
    expect(fake.workspaces.map((item) => item.label)).toEqual(["my checkout", "scout·look"]);
  });

  test("refuses a worktree already open in Herdr without closing it", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.workspaces.push({
      workspace_id: "space-other",
      label: "someone",
      checkout: join(`${root}-leases`, ".treehouse-taken"),
    });
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "implementation", name: "taken", task: "work" }],
    });
    expect((result.details as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: "starting",
      phase: "opening_space",
    });
    expect(fake.workspaces.find((item) => item.workspace_id === "space-other")?.label).toBe(
      "someone",
    );
    expect(
      fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toBe(false);
    expect(fake.calls.some((call) => call.command === "herdr" && call.args.includes("start"))).toBe(
      false,
    );
    const closed = await instance.runWorkers({ op: "close", names: ["taken"], discard: true });
    expect((closed.details as Outcome[])[0]!.close).toBe("closed");
    expect(fake.workspaces.find((item) => item.workspace_id === "space-other")?.label).toBe(
      "someone",
    );
    expect(
      fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toBe(true);
  });
  test("retains a lease when a pre-start space cannot close", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.shellWaitFails = true;
    fake.spaceCloseFails = true;
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "implementation", name: "kept", task: "work" }],
    });
    expect((result.details as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: "starting",
      phase: "opening_space",
      worktree: join(`${root}-leases`, ".treehouse-kept"),
    });
    expect(
      fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toBe(false);
    expect((await instance.runWorkers({ op: "list" })).details).toHaveLength(1);
    expect(
      (
        (await runtime(root, fake, []).runWorkers({ op: "list" })).details as Array<
          Record<string, unknown>
        >
      )[0]?.name,
    ).toBe("kept");
  });

  test("selects an OMP model role per task", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const invalid = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "scout", name: "invalid", task: "work", role: "@smol" }],
    });
    expect(invalid.content[0].text).toContain("Invalid OMP model role");
    expect(fake.calls.some((call) => call.command === "treehouse")).toBe(false);

    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [
        { kind: "scout", name: "default", task: "work" },
        { kind: "scout", name: "fast", task: "work", role: "smol" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(fake.status.get("pane:fast")).toBe("working");
    expect(
      (result.details as Array<Record<string, unknown>>).find((worker) => worker.name === "fast")
        ?.role,
    ).toBe("smol");
  });

  test("starts an exact OMP model with its thinking level and keeps it across relaunch", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [
        { kind: "scout", name: "deep", task: "work", model: "anthropic/claude-opus-5-5:high" },
        { kind: "scout", name: "free", task: "work", model: "openrouter/qwen/qwen3-coder:free" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toContainEqual(
      expect.objectContaining({
        name: "deep",
        model: "anthropic/claude-opus-5-5",
        thinking: "high",
      }),
    );

    instance.dispose();
    fake.goneAgents.add("pane:deep");
    const restarted = runtime(root, fake, []);
    await restarted.runWorkers({ op: "list" });
    fake.goneAgents.delete("pane:deep");
    fake.calls.length = 0;
    await restarted.runWorkers({ op: "relaunch", names: ["deep"], note: "The tab crashed" });
    expect((await restarted.runWorkers({ op: "list" })).details).toContainEqual(
      expect.objectContaining({
        name: "deep",
        status: "working",
        model: "anthropic/claude-opus-5-5",
        thinking: "high",
      }),
    );
  });

  test("rejects inexact models and unsupported thinking before acquiring resources", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);
    for (const item of [
      { model: "opus" },
      { model: "anthropic/claude-opus-5-5:ultra" },
      { model: "openrouter/qwen/qwen3-coder:free:high" },
      { model: "anthropic/claude-opus-5-5", role: "smol" },
    ]) {
      const result = await instance.runTask({
        project: "fixture",
        context: "",
        tasks: [{ kind: "scout", name: "picky", task: "work", ...item }],
      });
      expect(result.isError).toBe(true);
      expect(fake.workerHeads.size).toBe(0);
      expect(fake.workspaces).toEqual([]);
    }
  });

  test("rejects empty role and pushTo before acquiring resources", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);

    for (const [item, expected] of [
      [
        { kind: "scout" as const, name: "empty-role", task: "work", role: "" },
        "Invalid OMP model role",
      ],
      [
        { kind: "implementation" as const, name: "empty-push", task: "work", pushTo: "" },
        "pushTo for empty-push must be non-empty",
      ],
    ] as const) {
      const before = fake.calls.length;
      const result = await instance.runTask({ project: "fixture", context: "", tasks: [item] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(expected);
      expect(
        fake.calls
          .slice(before)
          .some((call) => call.command === "treehouse" || call.command === "herdr"),
      ).toBe(false);
    }
  });

  test("launches concurrently and steers only named workers", async () => {
    const { fake, instance, result } = await launchedPair();
    expect(result.content[0].text).toStartWith("Visible workers launched:\n");
    expect(fake.waits.size).toBe(2);
    await instance.runWorkers({ op: "send", names: ["alpha"], message: "changed" });
    const prompts = fake.calls.filter(
      (call) => call.command === "herdr" && call.args.includes("prompt"),
    );
    expect(
      prompts
        .filter((call) => call.args.includes("changed"))
        .map((call) => call.args[call.args.indexOf("prompt") + 1]),
    ).toEqual(["pane:alpha"]);
    expect(fake.waits.has("pane:beta")).toBe(true);
  });

  test("retains an uncertain unstructured stalled submission without duplicating input", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.promptStallsOnce = true;
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "implementation", name: "one", task: "work" }],
    });
    expect(result.isError).toBeUndefined();
    expect((result.details as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: "starting",
      phase: "submitting_prompt",
    });
    expect(fake.workspaces.some((space) => space.label === "impl·one")).toBe(true);
    expect(fake.status.get("pane:one")).not.toBe("working");
  });

  test("validates every target before sending", async () => {
    const { fake, instance } = await launchedPair();
    const before = fake.calls.length;
    const result = await instance.runWorkers({
      op: "send",
      names: ["alpha", "missing"],
      message: "changed",
    });
    expect(result.isError).toBe(true);
    expect(fake.calls.length).toBe(before);
  });

  test("keeps implementation local-delivery preflight strict", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);
    fake.projectDirty = true;
    expect(
      (
        await instance.runTask({
          project: "fixture",
          context: "",
          tasks: [{ kind: "implementation", name: "dirty", task: "work" }],
        })
      ).isError,
    ).toBe(true);
    fake.projectDirty = false;
    fake.projectBranch = "";
    expect(
      (
        await instance.runTask({
          project: "fixture",
          context: "",
          tasks: [{ kind: "implementation", name: "detached", task: "work" }],
        })
      ).isError,
    ).toBe(true);
    expect(fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "get")).toBe(
      false,
    );
    fake.projectBranch = "main";
    fake.branchHeads.set("release", "release123");
    expect(
      (
        await instance.runTask({
          project: "fixture",
          context: "",
          tasks: [
            { kind: "implementation", name: "wrong-branch", task: "work", startFrom: "release" },
          ],
        })
      ).isError,
    ).toBe(true);
  });
});
describe("delivery", () => {
  test("fast-forwards then rebases once and wakes the root", async () => {
    const { fake, messages, instance } = await launchedPair();
    fake.settle("alpha");
    await eventually(() => expect(messages.length).toBe(1));
    fake.settle("beta");
    await eventually(() => expect(messages.length).toBe(2));
    expect(messages.every((item) => item.message.startsWith("Visible worker result:\n"))).toBe(
      true,
    );
    expect(fake.workspaces.map((item) => item.label)).toEqual(["fixture"]);
    expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
  });

  test("records settled results as delivered events and lists them in history", async () => {
    const { messages, instance, fake } = await launchedPair();
    fake.settle("alpha");
    await eventually(() => expect(messages.length).toBe(1));
    expect((await instance.runWorkers({ op: "events" })).details).toEqual([]);
    const history = (await instance.runWorkers({ op: "events", all: true })).details as Array<{
      worker?: string;
      message: string;
      deliveredAt?: string;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ worker: "alpha", message: messages[0]!.message });
    expect(history[0]!.deliveredAt).toBeString();
  });

  test("keeps undeliverable events pending until read or the next session start", async () => {
    const { root } = await fixtureRoot();
    const delivered: string[] = [];
    let wake = false;
    const api: ToolAPI = {
      cwd: root,
      exec: (async () => ({ stdout: "", stderr: "", code: 1 })) as ToolAPI["exec"],
      logger: {},
      zod,
      notify: (message) => {
        if (!wake) throw new Error("no wake path");
        delivered.push(message);
      },
    };
    const state = stateFor(api);
    try {
      state.active = true;
      notify(state, { name: "alpha", status: "failed" });
      notify(state, { name: "beta", status: "failed" });
      expect(state.store.pendingEvents().map((event) => event.worker)).toEqual(["alpha", "beta"]);
      const read = await runWorkers(state, { op: "events" });
      expect((read.details as Array<{ worker: string }>).map((event) => event.worker)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(state.store.pendingEvents()).toEqual([]);
      notify(state, { name: "gamma", status: "failed" });
      wake = true;
      handleSession(state, "start");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain('"name": "gamma"');
      expect(state.store.pendingEvents()).toEqual([]);
    } finally {
      disposeWorkers(state);
      state.store.close();
    }
  });

  test("the extension entry wakes the root session when a worker settles", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const messages: Array<{ message: string; options: unknown }> = [];
    const { instance } = extensionRuntime(root, fake, messages);
    await register(instance, project);
    await instance.runTask({
      project: "fixture",
      context: "shared",
      tasks: [{ kind: "implementation", name: "alpha", task: "A" }],
    });
    fake.settle("alpha");
    await eventually(() => expect(messages.length).toBe(1));
    expect(messages[0]!.message).toContain('"status": "merged"');
    expect(messages[0]!.options).toEqual({ triggerTurn: true, deliverAs: "nextTurn" });
  });

  test("reports only the worker's final assistant response", async () => {
    const { fake, messages } = await launchedPair();
    fake.sessionEntries.set("pane:alpha", [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Do A" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Plan the change" },
            { type: "toolCall", name: "edit", arguments: {} },
          ],
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Early" }] },
      },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Summarize" },
            { type: "text", text: "Changed A." },
            { type: "text", text: "Tests pass." },
          ],
        },
      },
      { type: "custom", data: { text: "status bar" } },
    ]);
    fake.settle("alpha");
    await eventually(() => expect(messages.length).toBe(1));
    const outcome = JSON.parse(messages[0]!.message.slice("Visible worker result:\n".length));
    expect(outcome).toMatchObject({ status: "merged", output: "Changed A.\n\nTests pass." });
  });

  test("delivers with an explicit unavailable response when Herdr has no session", async () => {
    const { fake, messages } = await launchedPair();
    fake.sessionless.add("pane:alpha");
    fake.settle("alpha");
    await eventually(() => expect(messages.length).toBe(1));
    const outcome = JSON.parse(messages[0]!.message.slice("Visible worker result:\n".length));
    expect(outcome).toMatchObject({
      status: "merged",
    });
  });

  test("pushes without force or changing the registered checkout", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const messages: Array<{ message: string; options: unknown }> = [];
    const instance = runtime(root, fake, messages);
    await register(instance, project);
    await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "implementation", name: "push", task: "publish", pushTo: "feature/result" }],
    });
    fake.settle("push");
    await eventually(() => expect(messages.length).toBe(1));
    expect(parsed(messages)[0]).toMatchObject({
      name: "push",
      status: "pushed",
      branch: "feature/result",
    });
  });

  test("retains blocked and dirty workers", async () => {
    const blocked = await launchedPair();
    blocked.fake.settle("alpha", "blocked");
    await eventually(() =>
      expect(blocked.messages.some((item) => item.message.includes('"status": "blocked"'))).toBe(
        true,
      ),
    );
    const alphaPath = [...blocked.fake.workerHeads.keys()].find((path) => path.endsWith("alpha"))!;
    const betaPath = [...blocked.fake.workerHeads.keys()].find((path) => path.endsWith("beta"))!;
    blocked.fake.dirtyWorkers.add(betaPath);
    blocked.fake.settle("beta");
    await eventually(() =>
      expect(blocked.messages.some((item) => item.message.includes("uncommitted changes"))).toBe(
        true,
      ),
    );
    const listed = (await blocked.instance.runWorkers({ op: "list" })).details as Array<
      Record<string, unknown>
    >;
    expect(listed.find((item) => item.name === "alpha")).toMatchObject({
      tab_id: "tab-alpha",
      pane_id: "pane:alpha",
      worktree: alphaPath,
    });
    expect(listed.find((item) => item.name === "beta")?.status).toBe("failed");
  });

  test("dispose aborts watchers without cleanup and keeps workers recorded", async () => {
    const { fake, instance } = await launchedPair();
    instance.dispose();
    await new Promise<void>(queueMicrotask);
    expect(fake.calls.some((call) => call.command === "herdr" && call.args.includes("close"))).toBe(
      false,
    );
    expect(
      fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toBe(false);
    expect(
      ((await instance.runWorkers({ op: "list" })).details as Array<Record<string, unknown>>).map(
        (item) => item.name,
      ),
    ).toEqual(["alpha", "beta"]);
  });
});
describe("durable state", () => {
  test("resumes recorded workers after a restart and delivers finished ones", async () => {
    const { root, fake, instance } = await launchedPair();
    instance.dispose();
    fake.status.set("pane:alpha", "done");
    const messages: Array<{ message: string; options: unknown }> = [];
    const restarted = runtime(root, fake, messages);
    await restarted.runWorkers({ op: "list" });
    await eventually(() => expect(messages.length).toBe(1));
    expect(messages[0]!.message).toContain('"name": "alpha"');
    expect(messages[0]!.message).toContain('"status": "merged"');
    fake.settle("beta");
    await eventually(() => expect(messages.length).toBe(2));
    expect((await runtime(root, fake, []).runWorkers({ op: "list" })).details).toEqual([]);
  });

  test("reports a worker whose agent disappeared while OMP was down", async () => {
    const { root, fake, instance } = await launchedPair();
    instance.dispose();
    fake.goneAgents.add("pane:alpha");
    const messages: Array<{ message: string; options: unknown }> = [];
    const listed = (await runtime(root, fake, messages).runWorkers({ op: "list" }))
      .details as Array<Record<string, unknown>>;
    expect(listed.find((item) => item.name === "alpha")).toMatchObject({
      status: "failed",
      connection: { herdr: { state: "attention", error: { code: "RESOURCE_NOT_FOUND" } } },
    });
    expect(parsed(messages)).toContainEqual(
      expect.objectContaining({ name: "alpha", status: "failed" }),
    );
    expect(
      fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toBe(false);
  });

  test("close refuses unlanded implementation work unless discard is set", async () => {
    const { root, fake, instance } = await launchedPair();
    const refused = (await instance.runWorkers({ op: "close", names: ["alpha"] })).details as Array<
      Record<string, unknown>
    >;
    expect(refused[0]).toMatchObject({
      name: "alpha",
      close: "refused",
      reason: expect.stringContaining("undelivered commits"),
    });
    expect(fake.calls.some((call) => call.command === "herdr" && call.args.includes("close"))).toBe(
      false,
    );

    const alphaPath = [...fake.workerHeads.keys()].find((path) => path.endsWith("alpha"))!;
    const betaPath = [...fake.workerHeads.keys()].find((path) => path.endsWith("beta"))!;
    fake.workerHeads.set(alphaPath, "a".repeat(40));
    const closed = (await instance.runWorkers({ op: "close", names: ["alpha"] })).details as Array<
      Record<string, unknown>
    >;
    expect(closed[0]).toMatchObject({ name: "alpha", close: "closed" });

    fake.dirtyWorkers.add(betaPath);
    const discarded = (await instance.runWorkers({ op: "close", names: ["beta"], discard: true }))
      .details as Array<Record<string, unknown>>;
    expect(discarded[0]).toMatchObject({ name: "beta", close: "closed" });

    expect(
      fake.calls.filter((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toHaveLength(2);
    expect(fake.workspaces.map((item) => item.label)).toEqual(["fixture"]);
    expect((await runtime(root, fake, []).runWorkers({ op: "list" })).details).toEqual([]);
  });
});

type Outcome = Record<string, unknown>;

function parsed(
  messages: Array<{ message: string }>,
  heading = "Visible worker result",
): Outcome[] {
  return messages
    .filter((item) => item.message.startsWith(`${heading}:\n`))
    .map((item) => JSON.parse(item.message.slice(heading.length + 2)) as Outcome);
}

describe("supervision", () => {
  test("shows a blocked worker's question and delivers after the user answers in its tab", async () => {
    const { fake, messages } = await launchedPair();
    fake.screens.set("pane:alpha", "Which database should I use?");
    fake.settle("alpha", "blocked");
    await eventually(() =>
      expect(parsed(messages)[0]).toMatchObject({
        name: "alpha",
        status: "blocked",
        output: "Which database should I use?",
      }),
    );
    // The user answers directly in the worker's tab; no send goes through the root.
    await eventually(() => expect(fake.waits.has("pane:alpha")).toBe(true));
    fake.settle("alpha", "working");
    await eventually(() => expect(fake.waits.has("pane:alpha")).toBe(true));
    fake.settle("alpha", "done");
    await eventually(() =>
      expect(parsed(messages).at(-1)).toMatchObject({ name: "alpha", status: "merged" }),
    );
    expect(fake.projectHead).toBe("head-alpha");
  });

  test("interrupt stops a turn without delivering, survives restart, and send resumes it", async () => {
    const { root, fake, messages, instance } = await launchedPair();
    const interrupted = (await instance.runWorkers({ op: "interrupt", names: ["alpha"] }))
      .details as Outcome[];
    expect(interrupted[0]).toMatchObject({
      name: "alpha",
      status: "interrupted",
      interrupt: "sent",
    });
    expect(
      fake.calls.some(
        (call) =>
          call.command === "herdr" && call.args.includes("send-keys") && call.args.at(-1) === "esc",
      ),
    ).toBe(true);

    instance.dispose();
    const restartedMessages: Array<{ message: string; options: unknown }> = [];
    const restarted = runtime(root, fake, restartedMessages);
    const listed = (await restarted.runWorkers({ op: "list" })).details as Outcome[];
    expect(listed.find((item) => item.name === "alpha")?.status).toBe("interrupted");
    for (let turn = 0; turn < 20; turn++) await new Promise<void>(setImmediate);
    // The idle agent after Escape must not be mistaken for a finished assignment.
    expect(parsed(messages).concat(parsed(restartedMessages))).toEqual([]);
    expect(fake.projectHead).toBe("a".repeat(40));

    await restarted.runWorkers({ op: "send", names: ["alpha"], message: "Continue" });
    fake.settle("alpha");
    await eventually(() =>
      expect(parsed(restartedMessages)[0]).toMatchObject({ name: "alpha", status: "merged" }),
    );
  });

  test("notifies once when the screen stops changing and once when a turn runs long", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const messages: Array<{ message: string; options: unknown }> = [];
    const instance = runtime(root, fake, messages);
    await register(instance, project);
    fake.screens.set("pane:slow", "Running bun test");
    const notices = () => parsed(messages, "Visible worker notice");
    // Fresh identity checks can also finish host-local session-file I/O.
    const advance = async (seconds: number) => {
      for (let elapsed = 0; elapsed < seconds; elapsed += 60) {
        vi.advanceTimersByTime(60_000);
        for (let turn = 0; turn < 40; turn++) await new Promise<void>(setImmediate);
      }
    };
    vi.useFakeTimers();
    try {
      await instance.runTask({
        project: "fixture",
        context: "",
        tasks: [{ kind: "implementation", name: "slow", task: "work" }],
      });
      await advance(240);
      expect(notices()).toEqual([]);
      await advance(120);
      expect(notices().map((item) => item.notice)).toEqual(["no_progress"]);
      expect(notices()[0]).toMatchObject({
        name: "slow",
        status: "working",
        output: "Running bun test",
      });
      await advance(3600);
      expect(notices().map((item) => item.notice)).toEqual(["no_progress", "long_turn"]);
      await advance(1200);
      expect(notices()).toHaveLength(2);
      // Inspection only: the worker keeps running and still delivers normally.
      fake.settle("slow");
      // setImmediate stays real under Bun's fake timers, so `eventually` still lets file I/O finish.
      await eventually(() => expect(parsed(messages)[0]).toMatchObject({ status: "merged" }));
      await advance(1200);
      expect(notices()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a second session may only look until the supervising session dies", async () => {
    const { root, fake, messages, instance } = await launchedPair();
    fake.screens.set("pane:alpha", "Editing src/app.ts");
    const otherMessages: Array<{ message: string; options: unknown }> = [];
    const other = runtime(root, fake, otherMessages);

    const listed = await other.runWorkers({ op: "list" });
    expect(listed.content[0].text).toContain("read-only");
    expect((listed.details as Outcome[]).map((item) => item.name)).toEqual(["alpha", "beta"]);
    expect(
      ((await other.runWorkers({ op: "read", names: ["alpha"] })).details as Outcome[])[0],
    ).toMatchObject({ name: "alpha", screen: "Editing src/app.ts" });
    const send = await other.runWorkers({ op: "send", names: ["alpha"], message: "stop" });
    expect(send.isError).toBe(true);
    expect(send.content[0].text).toContain("read-only");
    const launch = await other.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "scout", name: "look", task: "work" }],
    });
    expect(launch.isError).toBe(true);
    expect(
      fake.calls.filter(
        (call) =>
          call.command === "herdr" &&
          call.args[1] === "wait" &&
          call.args[2] === "pane:alpha" &&
          !call.args.includes("--timeout"),
      ),
    ).toHaveLength(1);

    fake.settle("alpha");
    await eventually(() => expect(parsed(messages)[0]).toMatchObject({ status: "merged" }));
    expect(otherMessages).toEqual([]);

    // Simulate the supervising OMP process crashing without releasing ownership.
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    const deadPid = exited.pid;
    const db = new Database(join(root, ".omp", "orchestrator.db"), { strict: true });
    db.query("UPDATE owner SET pid = $pid").run({ pid: deadPid });
    db.close();
    const reclaimed = await other.runWorkers({ op: "list" });
    expect(reclaimed.content[0].text).not.toContain("read-only");
    expect((reclaimed.details as Outcome[]).map((item) => item.name)).toEqual(["beta"]);
    instance.dispose();
    await eventually(() => expect(fake.waits.has("pane:beta")).toBe(true));
    fake.settle("beta");
    await eventually(() =>
      expect(parsed(otherMessages)[0]).toMatchObject({ name: "beta", status: "merged" }),
    );
  });

  test("relaunches a dead worker in its retained worktree with its original assignment", async () => {
    const { root, fake, instance } = await launchedPair();
    instance.dispose();
    fake.goneAgents.add("pane:alpha");
    const messages: Array<{ message: string; options: unknown }> = [];
    const restarted = runtime(root, fake, messages);
    await restarted.runWorkers({ op: "list" });
    fake.goneAgents.delete("pane:alpha");
    expect(
      (await restarted.runWorkers({ op: "relaunch", names: ["alpha"], note: " " })).isError,
    ).toBe(true);

    const before = fake.calls.length;
    const relaunched = (
      await restarted.runWorkers({ op: "relaunch", names: ["alpha"], note: "The tab crashed" })
    ).details as Outcome[];
    expect(relaunched[0]).toMatchObject({ name: "alpha", status: "working", relaunch: "started" });
    const calls = fake.calls.slice(before);
    // The retained checkout keeps its work: no reset and no new lease.
    expect(calls.some((call) => call.command === "git" && call.args.includes("reset"))).toBe(false);
    expect(calls.some((call) => call.command === "treehouse")).toBe(false);

    fake.settle("alpha");
    await eventually(() =>
      expect(parsed(messages).at(-1)).toMatchObject({
        name: "alpha",
        status: "merged",
      }),
    );
  });
});

async function supervisionFixture() {
  const fixture = await launchFixture();
  const messages: Array<{ message: string }> = [];
  const offline = { herdr: new Set<string>(), helper: false };
  const overrides = new Map<string, Record<string, unknown>>();
  const waiters = new Map<string, () => void>();
  let profile: "normal" | "removed" | "retargeted" = "normal";
  const exec = fixture.api.exec;
  fixture.api.notify = (message) => {
    messages.push({ message });
  };
  fixture.api.exec = async (command, input, options) => {
    const hostId = input[0] === "--machine" ? input[1]! : "local";
    const args = input[0] === "--machine" || input[0] === "--session" ? input.slice(2) : input;
    if (args[0] === "machine" && args[1] === "list") {
      const result = await exec(command, input, options);
      if (profile === "removed") result.stdout = "[]";
      if (profile === "retargeted")
        result.stdout = JSON.stringify([
          {
            id: "remote",
            label: "Renamed",
            target: "replacement-ssh",
            session: "agents",
            enabled: true,
          },
        ]);
      return result;
    }
    if (offline.herdr.has(hostId))
      return { code: 1, killed: false, stdout: "", stderr: "disconnected" };
    const host = fixture.hosts.get(hostId)!;
    const pane = host.state.panes.get(args[2]!);
    if (args[0] === "api" && args[1] === "snapshot") {
      const panes = [...host.state.panes].map(([pane_id, pane]) => ({
        pane_id,
        tab_id: pane.tab,
        workspace_id: pane.workspace,
        cwd: pane.cwd,
        terminal_id: `terminal-${pane_id}`,
        ...(pane.alias ? { agent: "omp", name: pane.alias } : {}),
      }));
      return {
        code: 0,
        killed: false,
        stderr: "",
        stdout: JSON.stringify({
          result: {
            snapshot: {
              panes,
              tabs: panes.map((pane) => ({ tab_id: pane.tab_id })),
              workspaces: [...host.state.workspaces.keys()].map((workspace_id) => ({
                workspace_id,
              })),
              agents: panes.filter((pane) => pane.agent),
            },
          },
        }),
      };
    }
    if (args[0] === "agent" && args[1] === "get" && pane && !pane.alias)
      return {
        code: 1,
        killed: false,
        stdout: "",
        stderr: JSON.stringify({ error: { code: "agent_not_found" } }),
      };
    if (args[0] === "agent" && args[1] === "read")
      return { code: 0, killed: false, stdout: "Same visible screen", stderr: "" };
    if (args[0] === "agent" && args[1] === "send-keys") {
      if (pane) pane.status = "idle";
      return { code: 0, killed: false, stdout: "{}", stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "wait") {
      const { promise, resolve, reject } = Promise.withResolvers<
        ExecResult & { killed: boolean }
      >();
      waiters.set(`${hostId}:${args[2]}`, () =>
        resolve({ code: 0, killed: false, stdout: "{}", stderr: "" }),
      );
      options?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      return promise;
    }
    const result = await exec(command, input, options);
    if (args[0] === "agent" && args[1] === "get" && result.code === 0 && overrides.has(hostId)) {
      const value = JSON.parse(result.stdout);
      Object.assign(value.result.agent, overrides.get(hostId));
      result.stdout = JSON.stringify(value);
    }
    return result;
  };
  const spawn = fixture.api.spawnStdio!;
  fixture.api.spawnStdio = (command, options) => {
    if (!offline.helper) return spawn(command, options);
    return {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error("SSH disconnected");
          },
        }),
      },
      stderr: (async function* () {})(),
      exited: Promise.resolve(255),
      kill: () => {},
    };
  };
  const resumed: WorkerState[] = [];
  const restart = async () => {
    disposeWorkers(resumed.at(-1) ?? fixture.state);
    const state = stateFor({ ...fixture.api });
    resumed.push(state);
    await runWorkers(state, { op: "list" });
    return state;
  };
  return {
    ...fixture,
    messages,
    offline,
    overrides,
    waiters,
    restart,
    profile: (value: typeof profile) => {
      profile = value;
    },
    close: async () => {
      for (const state of resumed) {
        disposeWorkers(state);
        state.store.close();
      }
      await fixture.close();
    },
  };
}

describe("bound-host supervision", () => {
  test("retries a proven refused allocation without allocating twice", async () => {
    const f = await supervisionFixture();
    try {
      const host = f.hosts.get("remote")!;
      host.state.refusedAllocations = 1;
      await f.registerRemote();
      await f.run({
        project: "repo",
        context: "",
        tasks: [{ kind: "scout", name: "retry", task: "Research" }],
      });
      expect(f.state.records.get("retry")?.status).toBe("working");
      expect(host.state.allocated).toBe(1);
      expect([...host.state.panes.values()].map((pane) => pane.prompts)).toEqual([1]);
      expect(
        f.state.store
          .operations({ name: "retry", launchId: f.state.records.get("retry")!.launch_id })
          .find((op) => op.operation === "worker.allocate")?.state,
      ).toBe("confirmed");
    } finally {
      await f.close();
    }
  });

  test("explicit close retires a fenced no-resource launch without opening topology", async () => {
    const f = await supervisionFixture();
    try {
      const host = f.hosts.get("remote")!;
      host.state.lost = "allocate-before";
      await f.run({
        scope: "independent",
        machine: "remote",
        context: "",
        tasks: [{ kind: "scout", name: "empty", task: "Research" }],
      });
      expect(f.state.records.get("empty")).toMatchObject({
        status: "starting",
        phase: "allocating",
      });
      const record = f.state.records.get("empty")!;
      const intent = f.state.store.operations({
        name: record.name,
        launchId: record.launch_id,
      })[0]!;
      expect(intent.state).toBe("uncertain");
      const lock = join(
        host.runtime.configuration.runtimeRoot,
        "controllers",
        f.state.store.controllerId,
        "mutation.lock",
      );
      await mkdir(lock);
      const blocked = (await runWorkers(f.state, { op: "close", names: ["empty"] }))
        .details as Outcome[];
      expect(blocked[0]).toMatchObject({ close: "retained" });
      expect(f.state.store.has("empty")).toBe(true);
      await rm(lock, { recursive: true });
      const outcome = (await runWorkers(f.state, { op: "close", names: ["empty"] }))
        .details as Outcome[];
      expect(outcome[0]).toMatchObject({ close: "closed", cleanup_pending: false });
      expect(f.state.store.has("empty")).toBe(false);
      expect(host.state.panes.size).toBe(0);
      expect(host.state.workspaces.size).toBe(0);
      await expect(
        workerHostCall(f.state, record, "operation.get", { operationId: intent.id }),
      ).rejects.toMatchObject({ detail: { code: "OPERATION_NOT_STARTED", effect: "none" } });
    } finally {
      await f.close();
    }
  });

  test("close retains a launch whose allocation entered the ledger and may have effects", async () => {
    const f = await supervisionFixture();
    try {
      const host = f.hosts.get("remote")!;
      host.state.lost = "allocate";
      await f.run({
        scope: "independent",
        machine: "remote",
        context: "",
        tasks: [{ kind: "scout", name: "uncertain-resource", task: "Research" }],
      });
      const outcome = (await runWorkers(f.state, { op: "close", names: ["uncertain-resource"] }))
        .details as Outcome[];
      expect(outcome[0]).toMatchObject({ close: "retained" });
      expect(f.state.store.has("uncertain-resource")).toBe(true);
    } finally {
      await f.close();
    }
  });

  test("retains an offline remote worker across restart while the local host finishes", async () => {
    const f = await supervisionFixture();
    try {
      await f.run({
        scope: "independent",
        machine: "remote",
        context: "",
        tasks: [{ kind: "scout", name: "remote-scout", task: "Research" }],
      });
      await f.run({
        scope: "independent",
        context: "",
        tasks: [{ kind: "scout", name: "local-scout", task: "Research" }],
      });
      const remoteRecord = f.state.records.get("remote-scout")!;
      const localRecord = f.state.records.get("local-scout")!;
      expect(remoteRecord.pane_id).toBe(localRecord.pane_id);
      const changedAt = remoteRecord.status_changed_at;
      f.offline.herdr.add("remote");
      f.offline.helper = true;
      const state = await f.restart();
      const retained = state.records.get("remote-scout")!;
      expect(retained.status).toBe("working");
      expect(retained.status_changed_at).toBe(changedAt);
      const read = await runWorkers(state, { op: "read", names: ["remote-scout", "local-scout"] });
      expect(read.details).toContainEqual(
        expect.objectContaining({
          name: "remote-scout",
          status: "working",
          machine: "remote",
          screen_error: expect.objectContaining({ code: "TRANSPORT_OFFLINE" }),
        }),
      );
      expect((read.details as Outcome[])[0]).not.toHaveProperty("screen");
      expect(read.details).toContainEqual(
        expect.objectContaining({ name: "local-scout", screen: "Same visible screen" }),
      );
      const local = state.records.get("local-scout")!;
      await writeFile(local.report_source_path!, "# Local report\nVerified.\n");
      f.hosts.get("local")!.state.panes.get(local.pane_id!)!.status = "done";
      f.waiters.get(`local:${local.pane_id}`)!();
      await eventually(() =>
        expect(parsed(f.messages)).toContainEqual(
          expect.objectContaining({
            name: "local-scout",
            status: "completed_with_report",
          }),
        ),
      );
      expect(await readFile(local.report_path!, "utf8")).toBe("# Local report\nVerified.\n");
      expect(state.records.has("local-scout")).toBe(false);
      expect(state.records.has("remote-scout")).toBe(true);
      expect([...f.hosts.get("remote")!.state.panes.values()][0]!.prompts).toBe(1);
      expect(f.hosts.get("remote")!.state.allocated).toBe(0);
      f.profile("removed");
      expect((await runWorkers(state, { op: "list", machine: "remote" })).details).toContainEqual(
        expect.objectContaining({ name: "remote-scout", machine: "remote" }),
      );
      expect((await runWorkers(state, { op: "list", machine: "local" })).details).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test("helper outage does not hide a fresh Herdr screen or alter the lifecycle clock", async () => {
    const f = await supervisionFixture();
    try {
      await f.run({
        scope: "independent",
        machine: "remote",
        context: "",
        tasks: [{ kind: "scout", name: "partial", task: "Research" }],
      });
      const record = f.state.records.get("partial")!;
      const changedAt = record.status_changed_at;
      f.offline.helper = true;
      await expect(
        workerHostCall(f.state, record, "worker.lookup", { launchId: record.launch_id! }),
      ).rejects.toThrow();
      const result = (await runWorkers(f.state, { op: "read", names: ["partial"] }))
        .details as Outcome[];
      expect(result[0]).toMatchObject({
        screen: "Same visible screen",
        observed_at: expect.any(String),
        connection: { herdr: { state: "online" }, helper: { state: "offline" }, state: "offline" },
      });
      expect(record.status).toBe("working");
      expect(record.status_changed_at).toBe(changedAt);
      f.offline.helper = false;
      await workerHostCall(f.state, record, "worker.lookup", { launchId: record.launch_id! });
      expect(record.connection?.state).toBe("online");
      f.profile("retargeted");
      const refused = (
        await runWorkers(f.state, { op: "send", names: ["partial"], message: "Correction" })
      ).details as Outcome[];
      expect(refused[0]).toMatchObject({ send: "refused", status: "working" });
      expect(record.connection?.herdr.state).toBe("attention");
      expect([...f.hosts.get("remote")!.state.panes.values()][0]!.prompts).toBe(1);
    } finally {
      await f.close();
    }
  });

  test("offline minutes suspend screen stalls and reconnect resets only the stall baseline", async () => {
    const f = await supervisionFixture();
    const advance = async (seconds: number) => {
      for (let elapsed = 0; elapsed < seconds; elapsed += 60) {
        vi.advanceTimersByTime(60_000);
        for (let turn = 0; turn < 40; turn++) await new Promise<void>(setImmediate);
      }
    };
    vi.useFakeTimers();
    try {
      await f.run({
        scope: "independent",
        machine: "remote",
        context: "",
        tasks: [{ kind: "scout", name: "offline", task: "Research" }],
      });
      const record = f.state.records.get("offline")!;
      const changedAt = record.status_changed_at;
      await advance(60);
      f.offline.herdr.add("remote");
      await advance(3600);
      const notices = () => parsed(f.messages, "Visible worker notice");
      expect(notices().map((item) => item.notice)).toEqual(["long_turn"]);
      expect(notices()[0]!.observation_gap_seconds).toBeGreaterThanOrEqual(3500);
      expect(notices()[0]).not.toHaveProperty("screen");
      expect(record.status).toBe("working");
      expect(record.status_changed_at).toBe(changedAt);
      f.offline.herdr.delete("remote");
      await advance(60);
      await advance(180);
      expect(notices().map((item) => item.notice)).toEqual(["long_turn"]);
      await advance(120);
      expect(notices().map((item) => item.notice)).toEqual(["long_turn", "no_progress"]);
      expect(record.status_changed_at).toBe(changedAt);
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  });

  test.each([
    { name: "somebody-else" },
    { cwd: "/foreign" },
    { pane_id: "recycled" },
    { tab_id: "foreign-tab" },
    { workspace_id: "foreign-space" },
    { terminal_id: "replaced-terminal" },
  ])("refuses recycled terminal input and closure: %j", async (override) => {
    const f = await supervisionFixture();
    try {
      await f.run({
        scope: "independent",
        machine: "remote",
        context: "",
        tasks: [{ kind: "scout", name: "owned", task: "Research" }],
      });
      const host = f.hosts.get("remote")!;
      f.overrides.set("remote", override);
      for (const params of [
        { op: "send" as const, names: ["owned"], message: "Correction" },
        { op: "relaunch" as const, names: ["owned"], note: "Recover" },
        { op: "close" as const, names: ["owned"], discard: true },
      ]) {
        const result = (await runWorkers(f.state, params)).details as Outcome[];
        expect(result[0]!.status).toBe("failed");
      }
      expect([...host.state.panes.values()][0]!.prompts).toBe(1);
      expect(host.state.panes.size).toBe(1);
      expect(f.state.store.has("owned")).toBe(true);
      expect(host.state.returned).toBe(0);
    } finally {
      await f.close();
    }
  });

  test.each(["allocate", "start", "prompt"])(
    "reconciles response lost after %s without replay",
    async (lost) => {
      const f = await supervisionFixture();
      try {
        await f.registerRemote();
        const host = f.hosts.get("remote")!;
        host.state.lost = lost;
        await f.run({
          project: "repo",
          context: "",
          tasks: [{ kind: "scout", name: "recover", task: "Research" }],
        });
        const state = await f.restart();
        const record = state.records.get("recover")!;
        expect(host.state.allocated).toBe(1);
        expect(record.worktree).toBe(host.state.leases[0]!.path);
        expect(record.lease_id).toBe(host.state.leases[0]!.lease_id);
        if (lost === "prompt") {
          expect(record.status).toBe("working");
          expect([...host.state.panes.values()][0]!.prompts).toBe(1);
        } else {
          expect(record.status).toBe("starting");
          expect([...host.state.panes.values()].reduce((n, pane) => n + pane.prompts, 0)).toBe(0);
        }
        await recoverWorker(state, record);
        expect(host.state.allocated).toBe(1);
        expect(host.state.mutations.get("prompt") ?? 0).toBe(lost === "prompt" ? 1 : 0);
      } finally {
        await f.close();
      }
    },
  );

  test("startup idle after an uncertain prompt cannot settle", async () => {
    const f = await supervisionFixture();
    try {
      const host = f.hosts.get("remote")!;
      host.state.lost = "prompt";
      host.state.idleAfterPrompt = true;
      await f.run({
        scope: "independent",
        machine: "remote",
        context: "",
        tasks: [{ kind: "scout", name: "idle", task: "Research" }],
      });
      const state = await f.restart();
      expect(state.records.get("idle")!.status).toBe("starting");
      expect(state.records.get("idle")!.phase).toBe("submitting_prompt");
      expect([...host.state.panes.values()][0]!.prompts).toBe(1);
      expect(parsed(f.messages)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test("remote relaunch preserves host, directory, commits and exact initial selection", async () => {
    const f = await supervisionFixture();
    try {
      await f.registerRemote();
      await f.run({
        project: "repo",
        context: "",
        tasks: [{ kind: "scout", name: "relaunch", task: "Research" }],
      });
      const record = f.state.records.get("relaunch")!;
      const host = f.hosts.get("remote")!;
      const directory = record.worktree!;
      const bindingRevision = record.agent_binding!.revision;
      await writeFile(join(directory, "retained.txt"), "Keep this commit\n");
      await f.git(directory, ["add", "."]);
      await f.git(directory, ["commit", "-m", "worker change"]);
      const head = await f.git(directory, ["rev-parse", "HEAD"]);
      host.state.modelMismatch = true;
      const result = (
        await runWorkers(f.state, { op: "relaunch", names: ["relaunch"], note: "Continue" })
      ).details as Outcome[];
      expect(result[0]).toMatchObject({
        relaunch: "started",
        status: "working",
        machine: "remote",
      });
      expect(record.worktree).toBe(directory);
      expect(await f.git(directory, ["rev-parse", "HEAD"])).toBe(head);
      expect(record.agent_binding!.revision).toBe(bindingRevision + 1);
      expect([...host.state.panes.values()][0]).toMatchObject({
        cwd: directory,
        model: "openai-codex/remote",
        thinking: "high",
      });
      expect(host.state.allocated).toBe(1);
      expect(f.hosts.get("local")!.state.panes.size).toBe(0);
      const ledger = await workerHostCall(f.state, record, "worker.lookup", {
        launchId: record.launch_id!,
      });
      expect(ledger.binding!.revision).toBe(record.agent_binding!.revision);
    } finally {
      await f.close();
    }
  });

  test("adopts an interrupted legacy local lease without renaming or inventing a source SHA", async () => {
    const f = await supervisionFixture();
    try {
      const host = f.hosts.get("local")!;
      const project = await canonicalPath(host.project);
      await mkdir(join(f.controller, ".omp"), { recursive: true });
      await writeFile(
        join(f.controller, ".omp", "projects.json"),
        JSON.stringify({
          version: 2,
          projects: { repo: { machine: "local", path: project.path, pathKey: project.pathKey } },
          roots: {},
        }),
      );
      await f.run({
        project: "repo",
        context: "",
        tasks: [{ kind: "implementation", name: "herdr-092-compatibility", task: "Preserve work" }],
      });
      const original = f.state.records.get("herdr-092-compatibility")!;
      disposeWorkers(f.state);
      const pane = host.state.panes.get(original.pane_id!)!;
      pane.alias = original.name;
      const holder = "omp-orchestrator:herdr-092-compatibility";
      host.state.leases[0]!.lease_holder = holder;
      await rm(join(host.runtime.configuration.runtimeRoot, "controllers"), {
        recursive: true,
        force: true,
      });
      const db = new Database(join(f.controller, ".omp", "orchestrator.db"));
      db.query(
        "UPDATE workers SET target_json=?,agent_name=?,agent_binding_json=NULL,source_head=NULL,lease_holder=?,status='interrupted',phase='retained' WHERE name=?",
      ).run(
        JSON.stringify({ kind: "unresolved_local", machineId: "local" }),
        original.name,
        holder,
        original.name,
      );
      db.close();
      const state = await f.restart();
      const adopted = state.records.get(original.name)!;
      expect(adopted).toMatchObject({
        status: "interrupted",
        agent_name: original.name,
        lease_holder: holder,
        lease_id: original.lease_id,
        worktree: original.worktree,
        target: { kind: "local" },
      });
      expect(adopted.source_head).toBeUndefined();
      expect(adopted.agent_binding!.agentName).toBe(original.name);
      expect(host.state.allocated).toBe(1);
      expect(host.state.returned).toBe(0);
      await verifyWorkerAgent(state, adopted);
      const lookup = await workerHostCall(state, adopted, "worker.lookup", {
        launchId: adopted.launch_id!,
      });
      expect(lookup.resource).toMatchObject({ scope: "project", lease: { leaseHolder: holder } });
      expect(lookup.resource).not.toHaveProperty("sourceHead");
    } finally {
      await f.close();
    }
  });
});

test("binds a newly materialized session before helper access and refuses a replacement session", async () => {
  const f = await supervisionFixture();
  try {
    const host = f.hosts.get("remote")!;
    const sessionRoot = join(host.root, "sessions");
    host.runtime.sessionRoots = [sessionRoot];
    const sessionPath = join(sessionRoot, "worker.jsonl");
    await mkdir(sessionRoot);
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Original response" }] },
      }) + "\n",
    );
    await f.run({
      scope: "independent",
      machine: "remote",
      context: "",
      tasks: [{ kind: "scout", name: "session", task: "Research" }],
    });
    const record = f.state.records.get("session")!;
    const revision = record.agent_binding!.revision;
    host.state.futureSessionPath = sessionPath;
    await refreshWorkerHost(f.state, record);
    expect(record.agent_binding).toMatchObject({ sessionPath, revision: revision + 1 });
    const response = await workerHostCall(f.state, record, "session.last-response", {
      launchId: record.launch_id!,
      sessionPath,
    });
    expect(response).toEqual({ text: "Original response" });
    host.state.futureSessionPath = join(sessionRoot, "replacement.jsonl");
    const read = (await runWorkers(f.state, { op: "read", names: ["session"] }))
      .details as Outcome[];
    expect(read[0]).toMatchObject({ screen_error: { code: "AGENT_MISMATCH" } });
    expect(read[0]).not.toHaveProperty("screen");
    await runWorkers(f.state, { op: "close", names: ["session"], discard: true });
    expect(host.state.panes.size).toBe(1);
    expect(f.state.store.has("session")).toBe(true);
  } finally {
    await f.close();
  }
});

test("relaunches a proved dead agent without trusting a recycled terminal", async () => {
  const f = await supervisionFixture();
  try {
    await f.registerRemote();
    await f.run({
      project: "repo",
      context: "",
      tasks: [{ kind: "scout", name: "dead", task: "Research" }],
    });
    const record = f.state.records.get("dead")!;
    const host = f.hosts.get("remote")!;
    const directory = record.worktree;
    host.state.panes.get(record.pane_id!)!.alias = undefined;
    const state = await f.restart();
    expect(state.records.get("dead")!.status).toBe("failed");
    const result = (
      await runWorkers(state, {
        op: "relaunch",
        names: ["dead"],
        note: "Recover the stopped agent",
      })
    ).details as Outcome[];
    expect(result[0]).toMatchObject({
      relaunch: "started",
      status: "working",
      worktree: directory,
      machine: "remote",
    });
    expect(host.state.allocated).toBe(1);
    expect(host.state.leases[0]!.path).toBe(directory);
    expect([...host.state.panes.values()][0]!.prompts).toBe(1);
  } finally {
    await f.close();
  }
});

test.each([
  { diagnostic: "Permission denied (publickey).", code: "SSH_AUTH" },
  { diagnostic: "Host key verification failed.", code: "SSH_HOST_KEY" },
])("keeps lifecycle state on SSH attention: $code", async ({ diagnostic, code }) => {
  const f = await supervisionFixture();
  try {
    await f.run({
      scope: "independent",
      machine: "remote",
      context: "",
      tasks: [{ kind: "scout", name: "attention", task: "Research" }],
    });
    const record = f.state.records.get("attention")!;
    const changedAt = record.status_changed_at;
    f.api.spawnStdio = () => ({
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {})(),
      stderr: (async function* () {
        yield new TextEncoder().encode(diagnostic);
      })(),
      exited: Promise.resolve(255),
      kill: () => {},
    });
    await expect(
      workerHostCall(f.state, record, "worker.lookup", { launchId: record.launch_id! }),
    ).rejects.toThrow();
    expect(record.connection).toMatchObject({
      state: "attention",
      helper: { state: "attention", error: { code } },
    });
    expect(record.status).toBe("working");
    expect(record.status_changed_at).toBe(changedAt);
    expect(record.error).toBeUndefined();
    expect(f.state.store.has("attention")).toBe(true);
  } finally {
    await f.close();
  }
});

test("recovers a lost helper binding acknowledgement without resubmitting the assignment", async () => {
  const f = await supervisionFixture();
  try {
    const spawn = f.api.spawnStdio!;
    let loseOnce = true;
    f.api.spawnStdio = (command, options) => {
      const transport = spawn(command, options);
      let input = "";
      let op = "";
      return {
        ...transport,
        stdin: {
          write: (bytes) => {
            input += typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
            return transport.stdin.write(bytes);
          },
          end: () => {
            op = validateHostRequest(JSON.parse(input)).op;
            return transport.stdin.end();
          },
        },
        stdout: (async function* () {
          for await (const bytes of transport.stdout) {
            if (loseOnce && op === "worker.bind-agent") {
              loseOnce = false;
              throw new Error("Binding committed; response lost");
            }
            yield bytes;
          }
        })(),
      };
    };
    await f.run({
      scope: "independent",
      machine: "remote",
      context: "",
      tasks: [{ kind: "scout", name: "lost-binding", task: "Research" }],
    });
    expect(f.state.records.get("lost-binding")!.status).toBe("starting");
    const state = await f.restart();
    const record = state.records.get("lost-binding")!;
    const lookup = await workerHostCall(state, record, "worker.lookup", {
      launchId: record.launch_id!,
    });
    expect(lookup.binding!.revision).toBe(1);
    expect(record.agent_binding!.revision).toBe(1);
    expect(record.status).toBe("starting");
    expect([...f.hosts.get("remote")!.state.panes.values()][0]!.prompts).toBe(0);
    expect(
      state.store.operations({ name: record.name, launchId: record.launch_id }),
    ).toContainEqual(
      expect.objectContaining({
        operation: "worker.bind-agent",
        state: "confirmed",
      }),
    );
  } finally {
    await f.close();
  }
});

async function settlementFixture(machine = "remote", subprocess = false) {
  const f = await supervisionFixture();
  const host = f.hosts.get(machine)!;
  const faults = {
    lost: new Set<string>(),
    closeLost: false,
    releaseFails: false,
    transfer: "",
    offline: false,
    refused: new Set<string>(),
    legacyMissing: new Set<string>(),
    offlineAfterLost: false,
  };
  const mutations = new Map<string, number>();
  const config = host.runtime.configuration;
  config.executables.git.prefixArgs = [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
  ];
  const leaseFile = join(host.root, "settlement-leases.json");
  const peerFile = join(f.base, "settlement-peer.ts");
  if (subprocess)
    await writeFile(
      peerFile,
      `
    import {createHostRuntime,dispatchHostRequest,nativeExec,streamHostReport} from ${JSON.stringify(fileURLToPath(new URL("../src/runtime/host.ts", import.meta.url)))};
    import {readFile,writeFile} from "node:fs/promises";
    const configuration = ${JSON.stringify(config)};
    const leasesPath = ${JSON.stringify(leaseFile)};
    const runtime = createHostRuntime(configuration, {logger:{},notify(){},exec:async(command,args,options)=>{
      if (args[0] === "treehouse-fixture") {
        const leases = JSON.parse(await readFile(leasesPath,"utf8"));
        if (args[1] === "status") return {code:0,killed:false,stderr:"",stdout:JSON.stringify(leases)};
        if (args[1] === "return") {
          const index = leases.findIndex(lease => lease.lease_id === args[args.indexOf("--if-lease-id")+1] && lease.lease_holder === args[args.indexOf("--if-lease-holder")+1]);
          if (index < 0) return {code:1,killed:false,stderr:"Foreign lease",stdout:""};
          leases.splice(index,1); await writeFile(leasesPath,JSON.stringify(leases));
          return {code:0,killed:false,stderr:"",stdout:"returned"};
        }
      }
      return nativeExec(command,args,options);
    }});
    const request = JSON.parse(await Bun.stdin.text());
    if (request.op === "report.read") {
      try {for await(const frame of streamHostReport(runtime,request)) console.log(JSON.stringify(frame));}
      catch(error) { console.error(error.message); process.exitCode=1; }
    } else {
      const reply = await dispatchHostRequest(runtime,request);
      console.log(JSON.stringify(reply)); if (!reply.ok) process.exitCode=1;
    }
  `,
    );
  const spawn: StdioSpawn = () => {
    let input = "";
    const { promise, resolve } = Promise.withResolvers<void>();
    let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
    const output = (async function* () {
      await promise;
      const request = validateHostRequest(JSON.parse(input));
      const op = request.op;
      if (
        [
          "delivery.land",
          "delivery.push",
          "report.ack",
          "worker.release",
          "worker.forget",
        ].includes(op)
      )
        mutations.set(op, (mutations.get(op) ?? 0) + 1);
      if (faults.offline) throw new Error("offline");
      if (faults.refused.delete(op) || faults.legacyMissing.has(op)) {
        const legacy = faults.legacyMissing.delete(op);
        yield new TextEncoder().encode(
          JSON.stringify({
            protocol: request.protocol,
            version: 1,
            requestId: request.requestId,
            hostId: host.hostId,
            ok: false,
            error: {
              code: legacy ? "OPERATION_UNCERTAIN" : "LOCK_BUSY",
              message: "Refused before any effect",
              channel: "helper",
              effect: legacy ? "unknown" : "none",
              retry: legacy ? "reconcile" : "user_action",
              operationId: request.operationId,
            },
          }) + "\n",
        );
        return;
      }
      if (op === "worker.release" && faults.releaseFails) {
        yield new TextEncoder().encode(
          JSON.stringify({
            protocol: request.protocol,
            version: 1,
            requestId: request.requestId,
            hostId: host.hostId,
            ok: false,
            error: {
              code: "PREREQUISITE_MISSING",
              channel: "helper",
              message: "Release prerequisite unavailable",
              effect: "none",
              retry: "user_action",
            },
          }) + "\n",
        );
        return;
      }
      if (subprocess) {
        child = Bun.spawn([process.execPath, peerFile], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        child.stdin.write(input);
        child.stdin.end();
        for await (const bytes of child.stdout) yield bytes;
        return;
      }
      if (request.op === "report.read") {
        for await (const frame of streamHostReport(host.runtime, request)) {
          if (frame.type === "chunk" && faults.transfer === "disconnect")
            throw new Error("disconnected mid-transfer");
          yield new TextEncoder().encode(JSON.stringify(frame) + "\n");
          if (frame.type === "chunk" && faults.transfer === "change")
            await writeFile(f.state.records.get("report")!.report_source_path!, "changed\n");
        }
      } else {
        const reply = await dispatchHostRequest(host.runtime, request);
        if (faults.lost.delete(op)) {
          if (faults.offlineAfterLost) faults.offline = true;
          throw new Error("effect applied, response lost");
        }
        yield new TextEncoder().encode(JSON.stringify(reply) + "\n");
      }
    })();
    return {
      stdin: {
        write: (data) => {
          input += typeof data === "string" ? data : new TextDecoder().decode(data);
        },
        end: resolve,
      },
      stdout: output,
      stderr: (async function* () {})(),
      exited: (async () => {
        await promise;
        while (subprocess && !child) await new Promise<void>(setImmediate);
        return child ? await child.exited : 0;
      })(),
      kill: () => {
        child?.kill();
      },
    };
  };
  const launchSpawn = f.api.spawnStdio!;
  f.api.spawnStdio = (command, options) => launchSpawn(command, options);
  const originalExec = f.api.exec;
  f.api.exec = async (command, args, options) => {
    const result = await originalExec(command, args, options);
    if (args.includes("close") && faults.closeLost) {
      faults.closeLost = false;
      return { code: 1, killed: true, stdout: "", stderr: "closed then disconnected" };
    }
    return result;
  };
  const launch = async (
    name: string,
    kind: "implementation" | "scout",
    options: { hold?: boolean; pushTo?: string; independent?: boolean } = {},
  ) => {
    if (machine === "remote") await f.registerRemote();
    else {
      const path = await canonicalPath(host.project);
      await mkdir(join(f.controller, ".omp"), { recursive: true });
      await writeFile(
        join(f.controller, ".omp", "projects.json"),
        JSON.stringify({
          version: 2,
          projects: { repo: { machine: "local", ...path } },
          roots: {},
        }),
      );
    }
    f.api.spawnStdio = launchSpawn;
    const result = await f.run(
      options.independent
        ? { scope: "independent", machine, context: "", tasks: [{ name, kind, task: "Research" }] }
        : {
            project: "repo",
            context: "",
            tasks: [
              {
                name,
                kind,
                task: "Work",
                ...(options.hold ? { hold: true } : {}),
                ...(options.pushTo ? { pushTo: options.pushTo } : {}),
              },
            ],
          },
    );
    expect(result.isError).toBeUndefined();
    const record = f.state.records.get(name)!;
    expect(record.status).toBe("working");
    f.api.spawnStdio = spawn;
    if (subprocess) await writeFile(leaseFile, JSON.stringify(host.state.leases));
    return record;
  };
  const commit = async (path: string, file: string, bytes: string) => {
    await writeFile(join(path, file), bytes);
    await f.git(path, ["add", file]);
    await f.git(path, ["commit", "-m", file]);
    return f.git(path, ["rev-parse", "HEAD"]);
  };
  const ready = (record: WorkerRecord) => {
    record.watch?.abort();
    record.generation++;
    record.status = "ready";
    host.state.panes.get(record.pane_id!)!.status = "done";
    f.state.store.save(record);
  };
  return { ...f, host, faults, mutations, launch, commit, ready, leaseFile };
}

describe("host settlement", () => {
  test.each([false, true])(
    "settles report ack and cleanup after pre-ledger refusals legacy=%s",
    async (legacy) => {
      const f = await settlementFixture();
      try {
        const record = await f.launch("refused-report", "scout");
        const bytes = "# Collected\\nNative evidence ü.\\n";
        await writeFile(record.report_source_path!, bytes);
        record.watch?.abort();
        f.host.state.panes.get(record.pane_id!)!.status = "done";
        (legacy ? f.faults.legacyMissing : f.faults.refused).add("report.ack");
        f.faults.refused.add("worker.release");
        f.faults.refused.add("worker.forget");
        await f.restart();
        await eventually(() =>
          expect(parsed(f.messages)).toContainEqual(
            expect.objectContaining({ status: "completed_with_report", cleanup_pending: false }),
          ),
        );
        expect(await readFile(record.report_path!, "utf8")).toBe(bytes);
        const meta = JSON.parse(await readFile(provenancePath(record.report_path!), "utf8"));
        expect(meta.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        expect(f.host.state.leases).toEqual([]);
        expect(f.host.state.panes.size).toBe(0);
        expect(f.state.store.has(record.name)).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  test.each([false, true])(
    "lands held host work and rebases a moved target over stdio subprocess=%s",
    async (subprocess) => {
      const f = await settlementFixture("remote", subprocess);
      try {
        const record = await f.launch("held-host", "implementation", { hold: true });
        const controllerHead = f.hosts.get("local")!.sourceHead;
        const workerHead = await f.commit(record.worktree!, "worker.txt", "worker\n");
        const movedHead = await f.commit(f.host.project, "target.txt", "target\n");
        f.ready(record);
        const result = (await runWorkers(f.state, { op: "land", names: [record.name] }))
          .details as Outcome[];
        expect(result[0]).toMatchObject({
          status: "merged",
          machine: "remote",
          cleanup_pending: false,
          receipt: { deliveryBase: movedHead },
        });
        const head = await f.git(f.host.project, ["rev-parse", "HEAD"]);
        expect(head).not.toBe(workerHead);
        expect(await f.git(f.host.project, ["merge-base", movedHead, head])).toBe(movedHead);
        expect(await readFile(join(f.host.project, "worker.txt"), "utf8")).toBe("worker\n");
        expect(await f.git(f.hosts.get("local")!.project, ["rev-parse", "HEAD"])).toBe(
          controllerHead,
        );
        expect(f.state.store.has(record.name)).toBe(false);
        expect(f.host.state.workspaces.has(record.workspace_id!)).toBe(false);
        if (subprocess) expect(JSON.parse(await readFile(f.leaseFile, "utf8"))).toEqual([]);
        else expect(f.host.state.returned).toBe(1);
      } finally {
        await f.close();
      }
    },
    15000,
  );

  test.each(["dirty", "branch", "conflict"])(
    "retains implementation on %s target",
    async (failure) => {
      const f = await settlementFixture();
      try {
        const record = await f.launch("retained", "implementation", { hold: true });
        const sha = await f.commit(
          record.worktree!,
          failure === "conflict" ? "source.txt" : "worker.txt",
          "worker\n",
        );
        if (failure === "dirty")
          await writeFile(join(f.host.project, "dirty.txt"), "not committed");
        if (failure === "branch") await f.git(f.host.project, ["switch", "research"]);
        if (failure === "conflict") await f.commit(f.host.project, "source.txt", "target\n");
        const targetBefore = await f.git(f.host.project, ["rev-parse", "HEAD"]);
        f.ready(record);
        const results = (await runWorkers(f.state, { op: "land", names: [record.name] }))
          .details as Outcome[];
        expect(results[0]).toMatchObject({ status: "failed" });
        expect(await f.git(record.worktree!, ["rev-parse", "HEAD"])).toBe(sha);
        expect(await f.git(f.host.project, ["rev-parse", "HEAD"])).toBe(targetBefore);
        expect(f.host.state.leases).toHaveLength(1);
        expect(f.host.state.panes.size).toBe(1);
        const discarded = (
          await runWorkers(f.state, { op: "close", names: [record.name], discard: true })
        ).details as Outcome[];
        expect(discarded[0]!.close).toBe("closed");
      } finally {
        await f.close();
      }
    },
  );

  test.each(["delivery.land", "delivery.push", "worker.release", "worker.forget"])(
    "reconciles %s response loss without duplicate mutation",
    async (lost) => {
      const f = await settlementFixture();
      try {
        const origin = join(f.base, "origin.git");
        await f.git(f.base, ["init", "--bare", origin]);
        await f.git(f.host.project, ["remote", "add", "origin", origin]);
        const record = await f.launch("lost", "implementation", {
          hold: true,
          ...(lost === "delivery.push" ? { pushTo: "published" } : {}),
        });
        const head = await f.commit(record.worktree!, "result.txt", "result\n");
        f.ready(record);
        f.faults.lost.add(lost);
        const outcome = (await runWorkers(f.state, { op: "land", names: [record.name] }))
          .details as Outcome[];
        expect(outcome[0]).toMatchObject({
          status: lost === "delivery.push" ? "pushed" : "merged",
          cleanup_pending: false,
        });
        expect(f.mutations.get(lost)).toBe(1);
        if (lost === "delivery.push") {
          expect(await f.git(origin, ["rev-parse", "refs/heads/published"])).toBe(head);
          expect(await f.git(f.host.project, ["rev-parse", "HEAD"])).toBe(f.host.sourceHead);
        } else {
          expect(await f.git(f.host.project, ["rev-parse", "HEAD"])).toBe(head);
          expect(await f.git(origin, ["for-each-ref", "--format=%(refname)"])).toBe("");
        }
      } finally {
        await f.close();
      }
    },
  );

  test("reconciles a lost space close and resumes partial cleanup from durable delivery", async () => {
    const f = await settlementFixture();
    try {
      const record = await f.launch("cleanup", "implementation", { hold: true });
      const sha = await f.commit(record.worktree!, "result.txt", "delivered\n");
      f.ready(record);
      f.faults.closeLost = true;
      f.faults.releaseFails = true;
      const outcome = (await runWorkers(f.state, { op: "land", names: [record.name] }))
        .details as Outcome[];
      expect(outcome[0]).toMatchObject({
        status: "merged",
        cleanup_pending: true,
        cleanup_phase: "releasing_directory",
      });
      expect(f.state.store.all()[0]!.terminal_outcome).toMatchObject({
        kind: "merged",
        receipt: { workerHead: sha },
      });
      expect(f.host.state.panes.size).toBe(0);
      f.faults.releaseFails = false;
      const restarted = await f.restart();
      expect(restarted.records.has(record.name)).toBe(false);
      expect(f.mutations.get("delivery.land")).toBe(1);
      expect(f.host.state.returned).toBe(1);
    } finally {
      await f.close();
    }
  });

  test("collects a report before acknowledgement and cleanup, and reads the archive with no host", async () => {
    const f = await settlementFixture();
    try {
      const record = await f.launch("report", "scout");
      const bytes = "# Näyttö\r\nVerified 😀.\r\n";
      await writeFile(record.report_source_path!, bytes);
      record.watch?.abort();
      f.host.state.panes.get(record.pane_id!)!.status = "done";
      f.faults.lost.add("report.ack");
      f.faults.lost.add("worker.release");
      await f.restart();
      await eventually(() =>
        expect(parsed(f.messages)).toContainEqual(
          expect.objectContaining({ status: "completed_with_report", cleanup_pending: false }),
        ),
      );
      expect(f.mutations.get("report.ack")).toBe(1);
      expect(f.mutations.get("worker.release")).toBe(1);
      f.profile("removed");
      f.faults.offline = true;
      const report = await getReport(basename(record.report_path!), f.controller);
      expect(report.content[0]).toMatchObject({ text: bytes });
      expect(report.details).toMatchObject({
        provenance: {
          machineId: "remote",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sourcePath: record.report_source_path,
        },
      });
      expect((await listReports("repo", f.controller)).details).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  test.each(["disconnect", "change", "symlink", "utf8", "conflict", "sidecar"])(
    "retains staging after %s report failure",
    async (failure) => {
      const f = await settlementFixture();
      try {
        const record = await f.launch("report", "scout");
        record.watch?.abort();
        await writeFile(record.report_source_path!, "# Report\n" + "x".repeat(140000));
        if (failure === "symlink") {
          await rm(record.report_source_path!);
          await symlink(join(f.host.project, "source.txt"), record.report_source_path!);
        }
        if (failure === "utf8")
          await writeFile(record.report_source_path!, Buffer.from([0xff, 0xfe]));
        if (failure === "conflict") {
          await mkdir(join(record.report_path!, ".."), { recursive: true });
          await writeFile(record.report_path!, "Controller report\n");
        }
        if (failure === "sidecar") {
          await mkdir(join(record.report_path!, ".."), { recursive: true });
          await writeFile(provenancePath(record.report_path!), '{"unrelated":true}');
        }
        f.faults.transfer = failure;
        const outcome = (await runWorkers(f.state, { op: "close", names: [record.name] }))
          .details as Outcome[];
        expect(outcome[0]!.close).toBe("retained");
        expect(f.state.store.has(record.name)).toBe(true);
        expect((await lstat(record.report_source_path!)).isFile() || failure === "symlink").toBe(
          true,
        );
        expect(f.host.state.returned).toBe(0);
        expect(
          (await readdir(join(record.report_path!, ".."))).filter((file) => file.endsWith(".tmp")),
        ).toEqual([]);
        if (failure === "conflict")
          expect(await readFile(record.report_path!, "utf8")).toBe("Controller report\n");
        if (failure === "sidecar")
          expect(await readFile(provenancePath(record.report_path!), "utf8")).toBe(
            '{"unrelated":true}',
          );
        f.faults.transfer = "";
        await rm(record.report_source_path!, { force: true });
        const closed = (
          await runWorkers(f.state, { op: "close", names: [record.name], discard: true })
        ).details as Outcome[];
        expect(closed[0]!.close).toBe("closed");
      } finally {
        await f.close();
      }
    },
  );

  test("identical collection retry keeps the receipt and differing source never overwrites", async () => {
    const f = await settlementFixture("local");
    try {
      const record = await f.launch("same", "scout");
      record.watch?.abort();
      await writeFile(record.report_source_path!, "# Same\n");
      const receipt = await collectReport(record, crypto.randomUUID(), { runtime: f.host.runtime });
      record.report_receipt = receipt;
      expect(await collectReport(record, receipt.operationId, { runtime: f.host.runtime })).toEqual(
        receipt,
      );
      const originalMeta = await readFile(provenancePath(record.report_path!), "utf8");
      await writeFile(
        provenancePath(record.report_path!),
        JSON.stringify({ ...JSON.parse(originalMeta), collectedAt: "2000-01-01T00:00:00.000Z" }),
      );
      await expect(
        collectReport(record, receipt.operationId, { runtime: f.host.runtime }),
      ).rejects.toMatchObject({ detail: { code: "DESTINATION_CONFLICT" } });
      await writeFile(provenancePath(record.report_path!), originalMeta);
      await writeFile(record.report_source_path!, "# Changed\n");
      await expect(
        collectReport(record, receipt.operationId, { runtime: f.host.runtime }),
      ).rejects.toMatchObject({ detail: { code: "DESTINATION_CONFLICT" } });
      expect(await readFile(record.report_path!, "utf8")).toBe("# Same\n");
      await rm(record.report_source_path!);
      expect(
        (
          (await runWorkers(f.state, { op: "close", names: [record.name], discard: true }))
            .details as Outcome[]
        )[0]!.close,
      ).toBe("closed");
      expect(
        (await getReport(basename(record.report_path!), f.controller)).content[0],
      ).toMatchObject({ text: "# Same\n" });
    } finally {
      await f.close();
    }
  });

  test.each(["local", "remote"])(
    "unfinished %s scout requires discard without a report, but valid staging is always archived",
    async (machine) => {
      const f = await settlementFixture(machine);
      try {
        const unfinished = await f.launch("unfinished", "scout", { independent: true });
        const refused = (await runWorkers(f.state, { op: "close", names: [unfinished.name] }))
          .details as Outcome[];
        expect(refused[0]!.close).toBe("retained");
        expect((await lstat(unfinished.working_directory!)).isDirectory()).toBe(true);
        const discarded = (
          await runWorkers(f.state, { op: "close", names: [unfinished.name], discard: true })
        ).details as Outcome[];
        expect(discarded[0]!.close).toBe("closed");
        await expect(lstat(unfinished.working_directory!)).rejects.toMatchObject({
          code: "ENOENT",
        });
        const valid = await f.launch("valid", "scout", { independent: true });
        await writeFile(valid.report_source_path!, "# Partial results\n");
        const closed = (
          await runWorkers(f.state, { op: "close", names: [valid.name], discard: true })
        ).details as Outcome[];
        expect(closed[0]!.close).toBe("closed");
        expect(await readFile(valid.report_path!, "utf8")).toBe("# Partial results\n");
        expect(
          JSON.parse(await readFile(provenancePath(valid.report_path!), "utf8")),
        ).toMatchObject({ machineId: machine });
        expect(f.host.state.panes.size).toBe(0);
        expect(f.host.state.workspaces.size).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
});

test.each(["local", "remote"])(
  "holds completed %s work until quiescent land, and refuses a resumed agent",
  async (machine) => {
    const f = await settlementFixture(machine);
    try {
      const record = await f.launch("review", "implementation", { hold: true });
      const head = await f.commit(record.worktree!, "held.txt", "review\n");
      record.watch?.abort();
      f.host.state.panes.get(record.pane_id!)!.status = "done";
      const state = await f.restart();
      await eventually(() => expect(state.records.get(record.name)!.status).toBe("ready"));
      expect(await f.git(f.host.project, ["rev-parse", "HEAD"])).toBe(f.host.sourceHead);
      f.host.state.panes.get(record.pane_id!)!.status = "working";
      expect(
        ((await runWorkers(state, { op: "land", names: [record.name] })).details as Outcome[])[0]!
          .land,
      ).toBe("refused");
      expect(f.host.state.leases).toHaveLength(1);
      f.host.state.panes.get(record.pane_id!)!.status = "done";
      const outcome = (await runWorkers(state, { op: "land", names: [record.name] }))
        .details as Outcome[];
      expect(outcome[0]).toMatchObject({ status: "merged", cleanup_pending: false });
      expect(await f.git(f.host.project, ["rev-parse", "HEAD"])).toBe(head);
    } finally {
      await f.close();
    }
  },
);

test("offline discard retains the worker and its owned location", async () => {
  const f = await settlementFixture();
  try {
    const record = await f.launch("unreachable", "scout", { independent: true });
    f.faults.offline = true;
    const outcome = (
      await runWorkers(f.state, { op: "close", names: [record.name], discard: true })
    ).details as Outcome[];
    expect(outcome[0]).toMatchObject({
      close: "retained",
      machine: "remote",
      working_directory: record.working_directory,
    });
    expect(f.host.state.panes.size).toBe(1);
    expect((await lstat(record.working_directory!)).isDirectory()).toBe(true);
    f.faults.offline = false;
    expect(
      (
        (await runWorkers(f.state, { op: "close", names: [record.name], discard: true }))
          .details as Outcome[]
      )[0]!.close,
    ).toBe("closed");
  } finally {
    await f.close();
  }
});

test("adopts a legacy dead local scout and preserves its archive-owned report during cleanup", async () => {
  const f = await settlementFixture("local");
  try {
    const record = await f.launch("legacy", "scout");
    record.watch?.abort();
    const reportPath = record.report_path!;
    await mkdir(join(reportPath, ".."), { recursive: true });
    await writeFile(reportPath, "# Legacy archive\n");
    await rm(join(f.host.runtime.configuration.runtimeRoot, "controllers", record.controller_id!), {
      recursive: true,
    });
    f.host.state.panes.get(record.pane_id!)!.alias = undefined;
    const db = new Database(join(f.controller, ".omp", "orchestrator.db"));
    db.query(
      "UPDATE workers SET target_json = ?, agent_binding_json = NULL, source_head = NULL, report_source_path = report_path, status = 'failed', phase = 'retained' WHERE name = ?",
    ).run(JSON.stringify({ kind: "unresolved_local", machineId: "local" }), record.name);
    db.close();
    const state = await f.restart();
    const outcome = (await runWorkers(state, { op: "close", names: [record.name] }))
      .details as Outcome[];
    expect(outcome[0]!.close).toBe("closed");
    expect(await readFile(reportPath, "utf8")).toBe("# Legacy archive\n");
    expect(JSON.parse(await readFile(provenancePath(reportPath), "utf8"))).toMatchObject({
      sourcePath: reportPath,
      machineId: "local",
    });
    expect(f.host.state.returned).toBe(1);
  } finally {
    await f.close();
  }
});

test("a moved published ref retains the lease until publication is proven again", async () => {
  const f = await settlementFixture();
  try {
    const origin = join(f.base, "published.git");
    await f.git(f.base, ["init", "--bare", origin]);
    await f.git(f.host.project, ["remote", "add", "origin", origin]);
    const record = await f.launch("publication", "implementation", {
      hold: true,
      pushTo: "result",
    });
    const sha = await f.commit(record.worktree!, "pushed.txt", "published\n");
    f.ready(record);
    f.faults.releaseFails = true;
    expect(
      ((await runWorkers(f.state, { op: "land", names: [record.name] })).details as Outcome[])[0],
    ).toMatchObject({ status: "pushed", cleanup_pending: true });
    await f.git(origin, ["update-ref", "refs/heads/result", f.host.sourceHead]);
    f.faults.releaseFails = false;
    const pending = (await runWorkers(f.state, { op: "close", names: [record.name] }))
      .details as Outcome[];
    expect(pending[0]).toMatchObject({
      status: "pushed",
      close: "retained",
      cleanup_pending: true,
    });
    expect(f.host.state.leases).toHaveLength(1);
    expect(f.mutations.get("delivery.push")).toBe(1);
    const send = (
      await runWorkers(f.state, {
        op: "send",
        names: [record.name],
        message: "Do not replay the settled assignment",
      })
    ).details as Outcome[];
    expect(send[0]!.send).toBe("refused");
    await f.git(origin, ["update-ref", "refs/heads/result", sha]);
    expect(
      ((await runWorkers(f.state, { op: "close", names: [record.name] })).details as Outcome[])[0]!
        .close,
    ).toBe("closed");
    expect(f.mutations.get("delivery.push")).toBe(1);
  } finally {
    await f.close();
  }
});

test("a crash after completed host cleanup retires the local record without contacting the forgotten host worker", async () => {
  const f = await settlementFixture();
  try {
    const record = await f.launch("retirement", "implementation", { hold: true });
    await f.commit(record.worktree!, "retired.txt", "retired\n");
    f.ready(record);
    const remove = f.state.store.delete.bind(f.state.store);
    f.state.store.delete = () => {
      throw new Error("Controller stopped before retiring its live record");
    };
    const outcome = (await runWorkers(f.state, { op: "land", names: [record.name] }))
      .details as Outcome[];
    expect(outcome[0]).toMatchObject({
      status: "merged",
      cleanup_pending: true,
      cleanup_phase: "complete",
    });
    expect(f.host.state.returned).toBe(1);
    f.state.store.delete = remove;
    f.faults.offline = true;
    const state = await f.restart();
    expect(state.store.has(record.name)).toBe(false);
    expect(f.mutations.get("delivery.land")).toBe(1);
    expect(f.mutations.get("worker.release")).toBe(1);
    expect(f.mutations.get("worker.forget")).toBe(1);
  } finally {
    await f.close();
  }
});

test.each([
  "gone",
  "space-gone",
  "close-lost",
  "close-unresolved",
  "extra-pane",
  "live",
  "foreign",
  "recycled",
  "offline",
  "incomplete",
  "report",
  "invalid",
  "lease-replaced",
  "moved-alias",
] as const)(
  "explicit close of the exact unresolved legacy scout preserves safety with %s evidence",
  async (evidence) => {
    const f = await settlementFixture("local");
    try {
      const record = await f.launch("herdr-092-compatibility", "scout");
      disposeWorkers(f.state);
      const holder = "omp-orchestrator:herdr-092-compatibility";
      const leaseId = record.lease_id!;
      const pane = f.host.state.panes.get(record.pane_id!)!;
      f.host.state.workspaces.delete(record.workspace_id!);
      record.workspace_id = "w1N";
      if (evidence !== "space-gone")
        f.host.state.workspaces.set("w1N", {
          label: "scout·herdr-092-compatibility",
          cwd: f.host.project,
          checkout: record.worktree,
        });
      pane.workspace = "w1N";
      pane.alias = evidence === "foreign" ? "unrelated-agent" : record.name;
      f.host.state.leases[0]!.lease_holder = holder;
      record.lease_holder = holder;
      record.agent_name = record.name;
      record.target = { kind: "unresolved_local", machineId: "local" };
      record.agent_binding = undefined;
      record.source_head = undefined;
      record.report_source_path = record.report_path;
      record.status = "failed";
      record.phase = "retained";
      const db = new Database(join(f.controller, ".omp", "orchestrator.db"));
      db.query(
        "UPDATE workers SET workspace_id = 'w1N', target_json = ?, agent_name = name, agent_binding_json = NULL, source_head = NULL, report_source_path = report_path, lease_holder = ?, status = 'failed', phase = 'retained' WHERE name = ?",
      ).run(JSON.stringify(record.target), holder, record.name);
      db.close();
      await rm(join(f.host.runtime.configuration.runtimeRoot, "controllers"), {
        recursive: true,
        force: true,
      });
      if (evidence !== "live" && evidence !== "foreign") f.host.state.panes.delete(record.pane_id!);
      if (evidence === "recycled") {
        f.host.state.workspaces.set("w1N", { label: "unrelated", cwd: f.host.root });
        f.host.state.panes.set(record.pane_id!, {
          ...pane,
          cwd: f.host.root,
          alias: "replacement",
        });
      }
      if (evidence === "offline") f.offline.herdr.add("local");
      if (evidence === "incomplete") {
        const execute = f.api.exec;
        f.api.exec = async (command, args, options) =>
          args.includes("snapshot")
            ? {
                code: 0,
                killed: false,
                stderr: "",
                stdout: JSON.stringify({ result: { snapshot: { panes: [] } } }),
              }
            : execute(command, args, options);
      }
      if (evidence === "report")
        await writeFile(record.report_path!, "# Retained legacy evidence\n");
      if (evidence === "invalid") await writeFile(record.report_path!, " \n");
      if (evidence === "lease-replaced") f.host.state.leases[0]!.lease_holder = "unrelated-holder";
      if (evidence === "moved-alias")
        f.host.state.panes.set("unrelated-pane", {
          ...pane,
          workspace: "other-space",
          tab: "other-tab",
          cwd: f.host.root,
        });
      if (evidence === "extra-pane")
        f.host.state.panes.set("unrelated-pane", { ...pane, alias: undefined });
      if (evidence === "close-lost") f.faults.closeLost = true;
      if (evidence === "close-unresolved") {
        const execute = f.api.exec;
        let lost = false;
        f.api.exec = async (command, args, options) => {
          if (args.includes("close") && !lost) {
            lost = true;
            return {
              code: 1,
              killed: true,
              stdout: "",
              stderr: "Uncertain close; no observation of its effect",
            };
          }
          return execute(command, args, options);
        };
      }
      const state = await f.restart();
      const outcome = (await runWorkers(state, { op: "close", names: [record.name] }))
        .details as Outcome[];
      if (["gone", "space-gone", "close-lost", "report"].includes(evidence)) {
        expect(outcome[0]).toMatchObject({ close: "closed", cleanup_pending: false });
        expect(state.store.has(record.name)).toBe(false);
        expect(f.host.state.leases).toEqual([]);
        expect(f.host.state.returned).toBe(1);
        if (evidence === "report") {
          expect(await readFile(record.report_path!, "utf8")).toBe("# Retained legacy evidence\n");
          expect(
            JSON.parse(await readFile(provenancePath(record.report_path!), "utf8")),
          ).toMatchObject({
            sourcePath: record.report_path,
            machineId: "local",
          });
        }
      } else {
        expect(outcome[0]).toMatchObject({ close: "retained" });
        expect(state.store.has(record.name)).toBe(true);
        expect(f.host.state.returned).toBe(0);
        expect(f.host.state.leases).toMatchObject([
          {
            lease_id: leaseId,
            lease_holder: evidence === "lease-replaced" ? "unrelated-holder" : holder,
          },
        ]);
        if (evidence === "close-unresolved") {
          const retained = (await runWorkers(state, { op: "close", names: [record.name] }))
            .details as Outcome[];
          expect(retained[0]).toMatchObject({ close: "retained" });
          expect(f.host.state.workspaces.has("w1N")).toBe(true);
          expect(f.host.state.returned).toBe(0);
        }
        if (evidence === "invalid") {
          const discarded = (
            await runWorkers(state, { op: "close", names: [record.name], discard: true })
          ).details as Outcome[];
          expect(discarded[0]).toMatchObject({ close: "closed", cleanup_pending: false });
          expect(f.host.state.returned).toBe(1);
          expect(await readFile(record.report_path!, "utf8")).toBe(" \n");
        }
      }
    } finally {
      await f.close();
    }
  },
);

test("offline settlement preserves lifecycle and retries delivery in the same session", async () => {
  const f = await settlementFixture();
  try {
    const record = await f.launch("offline-settle", "implementation");
    record.watch?.abort();
    const head = await f.commit(record.worktree!, "result.txt", "done\n");
    f.host.state.panes.get(record.pane_id!)!.status = "done";
    vi.useFakeTimers();
    f.faults.offline = true;
    const state = await f.restart();
    const retained = state.records.get(record.name)!;
    await eventually(() => expect(retained.connection?.helper.state).toBe("offline"));
    expect(retained.status).toBe("working");
    expect(parsed(f.messages).some((message) => message.status === "failed")).toBe(false);
    f.faults.offline = false;
    vi.advanceTimersByTime(1_000);
    await eventually(() => expect(state.records.has(record.name)).toBe(false));
    expect(await f.git(f.host.project, ["rev-parse", "HEAD"])).toBe(head);
    expect(parsed(f.messages)).toContainEqual(expect.objectContaining({ status: "merged" }));
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("held land remains ready after an offline blip", async () => {
  const f = await settlementFixture();
  try {
    const record = await f.launch("offline-land", "implementation", { hold: true });
    await f.commit(record.worktree!, "result.txt", "done\n");
    f.ready(record);
    vi.useFakeTimers();
    f.faults.offline = true;
    expect(
      ((await runWorkers(f.state, { op: "land", names: [record.name] })).details as Outcome[])[0],
    ).toMatchObject({ status: "ready", land: "retained" });
    f.faults.offline = false;
    expect(
      ((await runWorkers(f.state, { op: "land", names: [record.name] })).details as Outcome[])[0],
    ).toMatchObject({ status: "merged", cleanup_pending: false });
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test.each([false, true])(
  "send uses the current completion baseline with lost acknowledgement=%s",
  async (lost) => {
    const f = await settlementFixture();
    try {
      const record = await f.launch("send-baseline", "implementation", { hold: true });
      await f.commit(record.worktree!, "first.txt", "first\n");
      f.ready(record);
      const pane = f.host.state.panes.get(record.pane_id!)!;
      pane.completionSeq = 4;
      f.host.state.idleAfterPrompt = true;
      if (lost) f.host.state.lost = "prompt";
      vi.useFakeTimers();
      await runWorkers(f.state, { op: "send", names: [record.name], message: "Continue" });
      await recoverWorker(f.state, record);
      expect(record.status).toBe("starting");
      expect(record.delivery_receipt).toBeUndefined();
      expect(f.host.state.leases).toHaveLength(1);
      pane.completionSeq = 5;
      await recoverWorker(f.state, record);
      expect(record.status).toBe("working");
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  },
);

test.each(["open", "start"])(
  "relaunch reconciles lost %s acknowledgement and remains closable",
  async (lost) => {
    const f = await settlementFixture();
    try {
      const record = await f.launch(`relaunch-${lost}`, "implementation", { hold: true });
      f.ready(record);
      const revision = record.agent_binding!.revision;
      f.host.state.lost = lost;
      vi.useFakeTimers();
      await runWorkers(f.state, { op: "relaunch", names: [record.name], note: "Continue" });
      await eventually(() => expect(record.agent_binding?.revision).toBe(revision + 1));
      expect(record.status).not.toBe("failed");
      record.watch?.abort();
      const outcome = (
        await runWorkers(f.state, { op: "close", names: [record.name], discard: true })
      ).details as Outcome[];
      expect(outcome[0]).toMatchObject({ close: "closed", cleanup_pending: false });
      expect(f.host.state.leases).toHaveLength(0);
      expect(f.host.state.mutations.get("open")).toBe(2);
      expect(f.host.state.mutations.get("start")).toBe(2);
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  },
);

test("post-stop unlanded work refuses close without preventing relaunch and land", async () => {
  const f = await settlementFixture();
  try {
    const record = await f.launch("close-race", "implementation", { hold: true });
    f.ready(record);
    const exec = f.api.exec;
    let committed = false;
    f.api.exec = async (command, args, options) => {
      if (args.includes("close") && !committed) {
        committed = true;
        await f.commit(record.worktree!, "late.txt", "late\n");
      }
      return exec(command, args, options);
    };
    const closed = (await runWorkers(f.state, { op: "close", names: [record.name] }))
      .details as Outcome[];
    expect(closed[0]!.close).toBe("retained");
    expect(record.terminal_outcome).toBeUndefined();
    expect(f.host.state.leases).toHaveLength(1);
    const relaunched = (
      await runWorkers(f.state, { op: "relaunch", names: [record.name], note: "Keep late work" })
    ).details as Outcome[];
    expect(relaunched[0]!.relaunch).toBe("started");
    f.ready(record);
    const landed = (await runWorkers(f.state, { op: "land", names: [record.name] }))
      .details as Outcome[];
    expect(landed[0]).toMatchObject({ status: "merged", cleanup_pending: false });
    expect(await readFile(join(f.host.project, "late.txt"), "utf8")).toBe("late\n");
  } finally {
    await f.close();
  }
});

test("lost delivery acknowledgement reconciles after the agent exits", async () => {
  const f = await settlementFixture();
  try {
    const record = await f.launch("exited-delivery", "implementation", { hold: true });
    const head = await f.commit(record.worktree!, "done.txt", "done\n");
    f.ready(record);
    vi.useFakeTimers();
    f.faults.lost.add("delivery.land");
    f.faults.offlineAfterLost = true;
    const pending = (await runWorkers(f.state, { op: "land", names: [record.name] }))
      .details as Outcome[];
    expect(pending[0]!.land).toBe("retained");
    f.host.state.panes.get(record.pane_id!)!.alias = undefined;
    f.faults.offline = false;
    const landed = (await runWorkers(f.state, { op: "land", names: [record.name] }))
      .details as Outcome[];
    expect(landed[0]).toMatchObject({ status: "merged", cleanup_pending: false });
    expect(f.mutations.get("delivery.land")).toBe(1);
    expect(await f.git(f.host.project, ["rev-parse", "HEAD"])).toBe(head);
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("worker journals are launch-scoped and deletion rolls back atomically", async () => {
  const f = await settlementFixture();
  try {
    const record = await f.launch("journal", "implementation", { hold: true });
    f.ready(record);
    const store = f.state.store;
    const own = store.operations({ name: record.name, launchId: record.launch_id });
    const old = { ...own[0]!, id: crypto.randomUUID(), launchId: crypto.randomUUID() };
    store.saveOperation(old);
    expect(store.operations({ name: record.name, launchId: record.launch_id })).toEqual(own);
    expect(store.operations({ name: record.name, launchId: undefined })).toEqual([]);
    const db = new Database(join(f.controller, ".omp", "orchestrator.db"));
    try {
      db.run(
        "CREATE TRIGGER refuse_worker_delete BEFORE DELETE ON workers BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END",
      );
      expect(() => store.delete(record.name)).toThrow("fixture refusal");
      expect(store.has(record.name)).toBe(true);
      expect(store.operations({ name: record.name, launchId: record.launch_id })).toEqual(own);
      db.run("DROP TRIGGER refuse_worker_delete");
      store.delete(record.name);
      expect(store.has(record.name)).toBe(false);
      expect(store.operations().some((entry) => entry.workerName === record.name)).toBe(false);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("collected report retries an unacknowledged receipt after the agent exits", async () => {
  const f = await settlementFixture();
  try {
    const record = await f.launch("ack-offline", "scout");
    record.watch?.abort();
    await writeFile(record.report_source_path!, "# Durable report\n");
    f.host.state.panes.get(record.pane_id!)!.status = "done";
    f.faults.lost.add("report.ack");
    f.faults.offlineAfterLost = true;
    vi.useFakeTimers();
    const state = await f.restart();
    const retained = state.records.get(record.name)!;
    await eventually(() => expect(retained.connection?.helper.state).toBe("offline"));
    expect(retained.status).toBe("working");
    expect(retained.report_receipt).toBeDefined();
    expect(await readFile(record.report_path!, "utf8")).toBe("# Durable report\n");
    f.host.state.panes.get(record.pane_id!)!.alias = undefined;
    f.faults.offline = false;
    // Earlier offline observations may already have grown the reconnect backoff past its first step.
    vi.advanceTimersByTime(60_000);
    await eventually(() => expect(state.records.has(record.name)).toBe(false));
    expect(parsed(f.messages)).toContainEqual(
      expect.objectContaining({ status: "completed_with_report", cleanup_pending: false }),
    );
    expect(f.mutations.get("report.ack")).toBe(1);
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("unbound allocated launch preserves commits until explicit discard releases its lease", async () => {
  const f = await settlementFixture();
  try {
    await f.registerRemote();
    const exec = f.api.exec;
    f.api.exec = async (command, args, options) => {
      if (args.includes("worktree") && args.includes("open"))
        return {
          code: 1,
          killed: false,
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_mismatch" } }),
        };
      return exec(command, args, options);
    };
    await f.run({
      project: "repo",
      context: "",
      tasks: [{ name: "unbound", kind: "implementation", task: "Work" }],
    });
    const record = f.state.records.get("unbound")!;
    record.watch?.abort();
    expect(record.agent_binding).toBeUndefined();
    await f.commit(record.worktree!, "retained.txt", "retained\n");
    const refused = (await runWorkers(f.state, { op: "close", names: [record.name] }))
      .details as Outcome[];
    expect(refused[0]!.close).toBe("refused");
    expect(f.host.state.leases).toHaveLength(1);
    expect(record.terminal_outcome).toBeUndefined();
    const closed = (await runWorkers(f.state, { op: "close", names: [record.name], discard: true }))
      .details as Outcome[];
    expect(closed[0]).toMatchObject({ close: "closed", cleanup_pending: false });
    expect(f.host.state.leases).toHaveLength(0);
    expect(f.host.state.panes.size).toBe(0);
  } finally {
    await f.close();
  }
});
