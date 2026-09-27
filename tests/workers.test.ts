import { afterEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  cleanup,
  eventually,
  extensionRuntime,
  FakeExec,
  fixtureRoot,
  launchedPair,
  register,
  runtime,
} from "./test-helpers";

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
    expect(unknown.content[0].text).toContain("Registered: (none)");
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
    expect(
      fake.calls.some((call) => call.command === "treehouse" || call.command === "herdr"),
    ).toBe(false);
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
    expect(
      fake.calls
        .filter((call) => call.command === "herdr")
        .every((call) => !call.args.includes("--session")),
    ).toBe(true);
    expect(
      fake.calls.find((call) => call.command === "herdr" && call.args[0] === "worktree")?.args,
    ).toContain(project);
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
      checkout: join(project, ".treehouse-taken"),
    });
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "implementation", name: "taken", task: "work" }],
    });
    expect((result.details as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("already open"),
    });
    expect(fake.workspaces.find((item) => item.workspace_id === "space-other")?.label).toBe(
      "someone",
    );
    expect(
      fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toBe(true);
    expect(fake.calls.some((call) => call.command === "herdr" && call.args.includes("start"))).toBe(
      false,
    );
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
      status: "failed",
      error: expect.stringContaining("cleanup failed"),
      worktree: join(project, ".treehouse-kept"),
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
    const starts = fake.calls.filter(
      (call) => call.command === "herdr" && call.args.includes("start"),
    );
    expect(starts.find((call) => call.args.includes("fast"))?.args.slice(-2)).toEqual([
      "--model",
      "@smol",
    ]);
    expect(starts.find((call) => call.args.includes("default"))?.args).not.toContain("--model");
    expect(
      (result.details as Array<Record<string, unknown>>).find((worker) => worker.name === "fast")
        ?.role,
    ).toBe("smol");
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

  test("waits for the shell and retries only Enter after a stalled submission", async () => {
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
    const readiness = fake.calls.findIndex(
      (call) => call.command === "herdr" && call.args.includes("wait-output"),
    );
    const start = fake.calls.findIndex(
      (call) => call.command === "herdr" && call.args.includes("start"),
    );
    expect(readiness).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(readiness);
    expect(
      fake.calls.filter((call) => call.command === "herdr" && call.args.includes("prompt")),
    ).toHaveLength(1);
    expect(
      fake.calls.some(
        (call) =>
          call.command === "herdr" &&
          call.args.includes("send-keys") &&
          call.args.at(-1) === "enter",
      ),
    ).toBe(true);
    expect(fake.waits.has("pane:one")).toBe(true);
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
      ).content[0].text,
    ).toContain("must be clean");
    fake.projectDirty = false;
    fake.projectBranch = "";
    expect(
      (
        await instance.runTask({
          project: "fixture",
          context: "",
          tasks: [{ kind: "implementation", name: "detached", task: "work" }],
        })
      ).content[0].text,
    ).toContain("named branch");
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
      ).content[0].text,
    ).toContain("requires release to be checked out");
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
    expect(messages.map((item) => item.options)).toEqual([
      { triggerTurn: true, deliverAs: "nextTurn" },
      { triggerTurn: true, deliverAs: "nextTurn" },
    ]);
    expect(
      fake.calls.some(
        (call) =>
          call.command === "git" && call.args.includes("rebase") && call.args.includes("--onto"),
      ),
    ).toBe(true);
    expect(
      fake.calls
        .filter((call) => call.command === "herdr" && call.args.includes("close"))
        .map((call) => call.args.at(-1)),
    ).toEqual(["space-alpha", "space-beta"]);
    expect(fake.workspaces.map((item) => item.label)).toEqual(["fixture"]);
    const returns = fake.calls.filter(
      (call) => call.command === "treehouse" && call.args[0] === "return",
    );
    expect(returns).toHaveLength(2);
    expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
  });

  test("the extension entry wakes the root session when a worker settles", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const messages: Array<{ message: string; options: unknown }> = [];
    const { instance, registered } = extensionRuntime(root, fake, messages);
    expect(registered.toSorted()).toEqual(["orchestrator_task", "projects", "reports", "workers"]);
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
      output: "Worker response unavailable: Herdr reported no session path",
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
    const push = fake.calls.find((call) => call.command === "git" && call.args.includes("push"));
    expect(push?.args.slice(-3)).toEqual(["push", "origin", "HEAD:refs/heads/feature/result"]);
    expect(push?.args).not.toContain("--force");
    expect(
      fake.calls.some(
        (call) => call.command === "git" && call.args[1] === project && call.args.includes("merge"),
      ),
    ).toBe(false);
  });

  test("retains blocked, dirty, and conflicted workers", async () => {
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

    const conflict = await launchedPair();
    conflict.fake.projectHead = "advanced";
    conflict.fake.rebaseFails = true;
    conflict.fake.settle("alpha");
    await eventually(() =>
      expect(conflict.messages.some((item) => item.message.includes("conflict"))).toBe(true),
    );
    expect((await conflict.instance.runWorkers({ op: "list" })).details).toHaveLength(2);
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
      error: expect.stringContaining("could not be resumed"),
    });
    expect(messages.map((item) => item.message).join("\n")).toContain("could not be resumed");
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
    fake.workerHeads.set(alphaPath, "base");
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
  test("can close a worker whose commit was delivered before cleanup failed", async () => {
    const { fake, instance, messages } = await launchedPair();
    fake.spaceCloseFails = true;
    fake.settle("alpha");
    await eventually(() =>
      expect(messages.some((item) => item.message.includes("Cleanup failed"))).toBe(true),
    );
    expect(fake.projectHead).toBe("head-alpha");
    fake.projectHead = "head-later";
    fake.ancestors.add("head-alpha:head-later");
    fake.spaceCloseFails = false;
    const result = (await instance.runWorkers({ op: "close", names: ["alpha"] })).details as Array<
      Record<string, unknown>
    >;
    expect(result[0]).toMatchObject({ close: "closed", name: "alpha" });
    expect(fake.workspaces.map((item) => item.label).sort()).toEqual(["fixture", "impl·beta"]);
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
    expect(fake.projectHead).toBe("base");

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
    // Each supervision check awaits fake commands, which settle within a few microtask turns.
    const advance = async (seconds: number) => {
      for (let elapsed = 0; elapsed < seconds; elapsed += 60) {
        vi.advanceTimersByTime(60_000);
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
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
    const prompt = calls.find((call) => call.command === "herdr" && call.args.includes("prompt"));
    expect(prompt?.args[3]).toStartWith("shared\n\n");
    expect(prompt?.args[3]).toContain("\n\nA\n\nRecovery relaunch");
    expect(prompt?.args[3]).toEndWith("Note from the orchestrator: The tab crashed");
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

describe("delivery options", () => {
  test("holds an implementation for review and lands it on request", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const messages: Array<{ message: string; options: unknown }> = [];
    const instance = runtime(root, fake, messages);
    await register(instance, project);
    await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "implementation", name: "held", task: "work", hold: true }],
    });
    const early = (await instance.runWorkers({ op: "land", names: ["held"] })).details as Outcome[];
    expect(early[0]).toMatchObject({ land: "refused" });

    fake.settle("held");
    await eventually(() =>
      expect(parsed(messages)[0]).toMatchObject({
        status: "ready",
        head: "head-held",
        delivery_base: "base",
      }),
    );
    expect(fake.projectHead).toBe("base");
    expect(fake.workspaces.map((item) => item.label)).toContain("impl·held");

    const landed = (await instance.runWorkers({ op: "land", names: ["held"] }))
      .details as Outcome[];
    expect(landed[0]).toMatchObject({ name: "held", status: "merged" });
    expect(fake.projectHead).toBe("head-held");
    expect(fake.workspaces.map((item) => item.label)).toEqual(["fixture"]);
    expect(messages).toHaveLength(1);
    expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
  });

  test("opens a draft pull request after pushing and still delivers when that fails", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const messages: Array<{ message: string; options: unknown }> = [];
    const instance = runtime(root, fake, messages);
    await register(instance, project);
    fake.branchHeads.set("release", "release123");
    await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [
        {
          kind: "implementation",
          name: "opened",
          task: "work",
          pushTo: "feature/opened",
          startFrom: "release",
          pr: true,
        },
        { kind: "implementation", name: "refused", task: "work", pushTo: "feature/r", pr: true },
      ],
    });
    fake.settle("opened");
    await eventually(() =>
      expect(parsed(messages)[0]).toMatchObject({
        name: "opened",
        status: "pushed",
        pr_url: fake.prUrl,
      }),
    );
    const create = fake.calls.find((call) => call.command === "gh" && call.args[0] === "pr");
    expect(create?.args).toEqual([
      "pr",
      "create",
      "--draft",
      "--fill",
      "--head",
      "feature/opened",
      "--base",
      "release",
    ]);

    fake.prFails = true;
    fake.settle("refused");
    await eventually(() =>
      expect(parsed(messages)[1]).toMatchObject({
        name: "refused",
        status: "pushed",
        pr_error: expect.stringContaining("not authenticated"),
      }),
    );
    expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
  });
});
