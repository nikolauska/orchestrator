import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  eventually,
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
      fake.calls.find((call) => call.command === "herdr" && call.args.includes("create"))?.args,
    ).toContain("workspace");
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
    ).toEqual(["tab-alpha", "tab-beta"]);
    const returns = fake.calls.filter(
      (call) => call.command === "treehouse" && call.args[0] === "return",
    );
    expect(returns).toHaveLength(2);
    expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
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

  test("dispose aborts watchers without cleanup", async () => {
    const { fake, instance } = await launchedPair();
    instance.dispose();
    await new Promise<void>(queueMicrotask);
    expect(fake.calls.some((call) => call.command === "herdr" && call.args.includes("close"))).toBe(
      false,
    );
    expect(
      fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toBe(false);
    expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
  });
});
