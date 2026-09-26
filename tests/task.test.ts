import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanup,
  eventually,
  FakeExec,
  fixtureRoot,
  launchedIndependent,
  launchedScout,
  register,
  roots,
  runtime,
} from "./test-helpers";

afterEach(cleanup);
describe("worker prompts", () => {
  test("adds ponytail guidance only to implementation workers", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);

    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [
        { kind: "implementation", name: "implement", task: "Change" },
        { kind: "scout", name: "scout", task: "Investigate" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const promptFor = (pane: string) => {
      const call = fake.calls.find(
        (call) =>
          call.command === "herdr" &&
          call.args.includes("prompt") &&
          call.args[call.args.indexOf("prompt") + 1] === pane,
      );
      return call?.args[call.args.indexOf("prompt") + 2] ?? "";
    };
    expect(promptFor("pane:implement")).toContain("Use the ponytail skill for this assignment.");
    expect(promptFor("pane:scout")).not.toContain("ponytail");
  });
});

describe("scout reports", () => {
  test("launches from dirty detached HEAD and discloses excluded local changes", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.projectHead = "abc123";
    fake.projectBranch = "";
    fake.projectDirty = true;
    const instance = runtime(root, fake, []);
    await register(instance, project);

    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "scout", name: "inspect", task: "Investigate" }],
    });

    expect(result.isError).toBeUndefined();
    expect(
      fake.calls.find((call) => call.command === "git" && call.args.includes("reset"))?.args,
    ).toEqual(["-C", join(project, ".treehouse-inspect"), "reset", "--hard", "abc123"]);
    expect(
      fake.calls.some((call) => call.command === "git" && call.args[0] === "symbolic-ref"),
    ).toBe(false);
    const prompt =
      fake.calls
        .find((call) => call.command === "herdr" && call.args.includes("prompt"))
        ?.args.join(" ") ?? "";
    expect(prompt).toContain("exact committed revision abc123");
    expect(prompt).toContain("local changes are excluded");
    expect(prompt).toContain("dirty");
  });

  test("starts a scout from the selected local branch", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.branchHeads.set("release", "release123");
    const instance = runtime(root, fake, []);
    await register(instance, project);

    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "scout", name: "inspect", task: "Investigate", startFrom: "release" }],
    });

    expect(result.isError).toBeUndefined();
    expect(
      fake.calls.find((call) => call.command === "git" && call.args.includes("reset"))?.args,
    ).toEqual(["-C", join(project, ".treehouse-inspect"), "reset", "--hard", "release123"]);
    const prompt =
      fake.calls
        .find((call) => call.command === "herdr" && call.args.includes("prompt"))
        ?.args.join(" ") ?? "";
    expect(prompt).toContain("exact committed revision release123");
  });

  test("rejects scout push before acquiring resources", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);

    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [
        { kind: "scout", name: "inspect", task: "Investigate", pushTo: "forbidden" } as never,
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot set pushTo");
    expect(fake.calls.some((call) => call.command === "treehouse")).toBe(false);
  });

  test("keeps a flexible report while discarding scratch work", async () => {
    const { fake, messages, instance, reportPath } = await launchedScout();
    const report = "# Evidence-led result\n\nFinding stands.\n\nOpen decision: choose A or B.";
    await writeFile(reportPath, report);
    fake.outputs.set("pane:scout", "Concise conclusion.");
    const worktree = [...fake.workerHeads.keys()][0];
    fake.dirtyWorkers.add(worktree);

    fake.settle("scout");
    await eventually(() => expect(messages.length).toBe(1));

    const outcome = JSON.parse(messages[0].message.slice("Visible worker result:\n".length));
    expect(outcome).toMatchObject({
      kind: "scout",
      status: "completed_with_report",
      output: "Concise conclusion.",
      report,
      report_path: reportPath,
    });
    expect(
      fake.calls.some(
        (call) =>
          call.command === "git" && (call.args.includes("merge") || call.args.includes("push")),
      ),
    ).toBe(false);
    expect(fake.calls.some((call) => call.command === "herdr" && call.args.includes("close"))).toBe(
      true,
    );
    expect(
      fake.calls.some((call) => call.command === "treehouse" && call.args[0] === "return"),
    ).toBe(true);
    await instance.runProjects({ op: "remove", name: "fixture" });
    expect(await readFile(reportPath, "utf8")).toBe(report);
  });

  test("retains scouts with missing, empty, or non-regular reports", async () => {
    for (const [, prepare, message] of [
      ["missing", async (_path: string) => {}, "missing or unreadable"],
      [
        "empty",
        async (path: string) => {
          await writeFile(path, " \n");
        },
        "empty",
      ],
      [
        "directory",
        async (path: string) => {
          await mkdir(path);
        },
        "not a regular file",
      ],
    ] as const) {
      const launched = await launchedScout();
      await prepare(launched.reportPath);
      launched.fake.settle("scout");
      await eventually(() => expect(launched.messages.length).toBe(1));
      expect(launched.messages[0].message).toContain(message);
      expect((await launched.instance.runWorkers({ op: "list" })).details).toHaveLength(1);
      expect(
        launched.fake.calls.some((call) => call.command === "herdr" && call.args.includes("close")),
      ).toBe(false);
      expect(
        launched.fake.calls.some(
          (call) => call.command === "treehouse" && call.args[0] === "return",
        ),
      ).toBe(false);
    }
  });
});
describe("project-independent scouts", () => {
  test("rejects invalid and mixed scopes before acquiring resources", async () => {
    const { root, project } = await fixtureRoot();
    const neutralRoot = `${root}-neutral`;
    roots.push(neutralRoot);
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, [], undefined, neutralRoot);
    for (const params of [
      {
        scope: "independent",
        context: "",
        tasks: [{ kind: "implementation", name: "write", task: "Change files" }],
      },
      {
        scope: "independent",
        context: "",
        tasks: [{ kind: "scout", name: "push", task: "Research", pushTo: "branch" }],
      },
      {
        scope: "project",
        context: "",
        tasks: [{ kind: "scout", name: "bad-scope", task: "Research" }],
      },
      {
        scope: "independent",
        project: "fixture",
        context: "",
        tasks: [{ kind: "scout", name: "mixed", task: "Research" }],
      },
    ]) {
      expect((await instance.runTask(params as never)).isError).toBe(true);
    }
    expect(fake.calls).toHaveLength(0);
    expect(
      await lstat(neutralRoot).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("rejects research inside a registered project before creating a space", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, [], undefined, join(project, "research"));
    await register(instance, project);
    const result = await instance.runTask({
      scope: "independent",
      context: "",
      tasks: [{ kind: "scout", name: "outside", task: "Research" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("inside reserved project context"),
    });
    expect(
      fake.calls.some((call) => call.command === "herdr" && call.args.includes("create")),
    ).toBe(false);
  });

  test("launches concurrently without registry, Git, or Treehouse and states provenance policy", async () => {
    const launched = await launchedIndependent([
      { kind: "scout", name: "market-a", task: "Research A" },
      { kind: "scout", name: "market-b", task: "Research B" },
    ]);
    expect(launched.result.isError).toBeUndefined();
    const records = launched.result.details as Array<Record<string, unknown>>;
    const directories = records.map((record) => record.working_directory as string);
    expect(new Set(directories).size).toBe(2);
    expect(directories.every((path) => path.startsWith(`${launched.neutralRoot}/`))).toBe(true);
    expect(
      records.every(
        (record) =>
          record.scope === "independent" &&
          !("project" in record) &&
          !("worktree" in record) &&
          !("lease_id" in record) &&
          !("delivery_base" in record),
      ),
    ).toBe(true);
    expect(
      records.every((record) => String(record.report_path).includes("/.omp/reports/_independent/")),
    ).toBe(true);
    expect(
      launched.fake.calls.some((call) => call.command === "git" || call.command === "treehouse"),
    ).toBe(false);
    const starts = launched.fake.calls.filter(
      (call) => call.command === "herdr" && call.args.includes("start"),
    );
    expect(starts.map((call) => call.args[call.args.indexOf("--cwd") + 1]).sort()).toEqual(
      directories.sort(),
    );
    const prompt =
      launched.fake.calls
        .find((call) => call.command === "herdr" && call.args.includes("prompt"))
        ?.args.join(" ") ?? "";
    for (const required of [
      "project-independent scout",
      "No registered-project checkout or project revision applies",
      "project-specific context is intentionally excluded",
      "Scratch files",
      "Public web search",
      "authenticated external systems",
      "source URLs",
      "research date",
      "authoritative, non-empty standalone Markdown report",
    ])
      expect(prompt).toContain(required);
    for (const excluded of [
      "exact committed revision",
      "local changes are excluded",
      "disposable worktree",
      "ponytail",
    ])
      expect(prompt).not.toContain(excluded);
  });

  test("runs scouts as tabs in one shared research space", async () => {
    const launched = await launchedIndependent([
      { kind: "scout", name: "first", task: "Research" },
      { kind: "scout", name: "second", task: "Research" },
    ]);
    await launched.instance.runTask({
      scope: "independent",
      context: "",
      tasks: [{ kind: "scout", name: "third", task: "Research" }],
    });
    const herdr = (group: string, action: string) =>
      launched.fake.calls.filter(
        (call) => call.command === "herdr" && call.args[0] === group && call.args[1] === action,
      );
    expect(herdr("workspace", "create").map((call) => call.args)).toEqual([
      expect.arrayContaining(["--label", "research"]),
    ]);
    const tabs = herdr("tab", "create");
    expect(tabs.map((call) => call.args[call.args.indexOf("--workspace") + 1])).toEqual([
      "space-research",
      "space-research",
      "space-research",
    ]);
    expect(tabs.map((call) => call.args[call.args.indexOf("--label") + 1]).sort()).toEqual([
      "scout·first",
      "scout·second",
      "scout·third",
    ]);
  });

  test("settles reports before removing the neutral directory", async () => {
    const launched = await launchedIndependent();
    const record = (launched.result.details as Array<Record<string, unknown>>)[0];
    const reportPath = record.report_path as string;
    const directory = record.working_directory as string;
    const report = "# Vendor research\n\nResearch date: 2026-08-02\n\nSource: https://example.com";
    await writeFile(reportPath, report);
    await writeFile(join(directory, "scratch.txt"), "disposable");
    launched.fake.outputs.set("pane:independent", "Compared vendors.");
    launched.fake.settle("independent");
    await eventually(() => expect(launched.messages.length).toBe(1));
    const outcome = JSON.parse(
      launched.messages[0].message.slice("Visible worker result:\n".length),
    );
    expect(outcome).toMatchObject({
      kind: "scout",
      scope: "independent",
      status: "completed_with_report",
      report,
      report_path: reportPath,
      working_directory: directory,
    });
    expect(
      "project" in outcome ||
        "worktree" in outcome ||
        "lease_id" in outcome ||
        "delivery_base" in outcome,
    ).toBe(false);
    expect(
      await lstat(directory).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await readFile(reportPath, "utf8")).toBe(report);
    expect((await launched.instance.runWorkers({ op: "list" })).details).toEqual([]);
  });

  test("retains neutral directories and tabs for report, blocked, and worker failures", async () => {
    for (const failure of ["report", "blocked", "worker"] as const) {
      const launched = await launchedIndependent([
        { kind: "scout", name: failure, task: "Research" },
      ]);
      const record = (launched.result.details as Array<Record<string, unknown>>)[0];
      const directory = record.working_directory as string;
      if (failure === "blocked") launched.fake.settle(failure, "blocked");
      else {
        if (failure === "worker") launched.fake.agentIdentity = "unexpected";
        launched.fake.settle(failure);
      }
      await eventually(() => expect(launched.messages.length).toBe(1));
      expect(
        await lstat(directory).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      const retained = (await launched.instance.runWorkers({ op: "list" })).details as Array<
        Record<string, unknown>
      >;
      expect(retained[0]).toMatchObject({ scope: "independent", working_directory: directory });
      expect(
        launched.fake.calls.some((call) => call.command === "herdr" && call.args.includes("close")),
      ).toBe(false);
    }
  });
});
