import { afterEach, describe, expect, test, vi } from "bun:test";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolOutcome } from "../src/core/tool";
import { cleanup, eventually, FakeExec, fixtureRoot, register, roots } from "./test-helpers";
import { runtime, launchedIndependent, launchedScout } from "./herdr-fixtures";
import { launchFixture } from "./task-fixtures";
import { runTask } from "../src/tools/orchestrator_task";
import { disposeWorkers, stateFor } from "../src/tools/workers";
import { WorkerStore } from "../src/runtime/store";
import { provenancePath } from "../src/runtime/report-transfer";
import { canonicalPath } from "../src/runtime/host-paths";

afterEach(cleanup);
describe("scout reports", () => {
  test("launches from dirty detached HEAD and discloses excluded local changes", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.projectHead = "c".repeat(40);
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
    expect((result.details as Array<Record<string, unknown>>)[0]).toMatchObject({
      local_changes: "dirty",
      delivery_base: "c".repeat(40),
    });
  });

  test("starts a scout from the selected local branch", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.branchHeads.set("release", "d".repeat(40));
    const instance = runtime(root, fake, []);
    await register(instance, project);

    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "scout", name: "inspect", task: "Investigate", startFrom: "release" }],
    });

    expect(result.isError).toBeUndefined();
    expect((result.details as Array<Record<string, unknown>>)[0]).toMatchObject({
      delivery_base: "d".repeat(40),
      start_from: "release",
    });
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

  test("collects the local scout report written to its assigned destination", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const messages: Array<{ message: string; options: unknown }> = [];
    const execute = fake.exec;
    const report = "# Local scout evidence\n\nCollection must preserve these bytes.\n";
    fake.exec = async (command, args, options) => {
      if (command === "herdr" && args.includes("prompt")) {
        // Simulate a scout honoring its actual assignment, rather than writing to a test-chosen path.
        const prompt = args[args.indexOf("prompt") + 2]!;
        const destination = prompt.match(/\/[^\s]+\.md(?=\s|$)/)?.[0];
        if (!destination) throw new Error("Scout report destination unavailable");
        await writeFile(destination, report);
      }
      return execute(command, args, options);
    };
    const instance = runtime(root, fake, messages);
    await register(instance, project);
    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "scout", name: "assigned", task: "Inspect local evidence" }],
    });
    expect(result.isError).toBeUndefined();
    const record = (result.details as Array<Record<string, unknown>>)[0]!;
    fake.settle("assigned");
    await eventually(() => expect(messages.length).toBe(1));
    const outcome = JSON.parse(messages[0]!.message.slice("Visible worker result:\n".length));
    expect(outcome).toMatchObject({ status: "completed_with_report", cleanup_pending: false });
    expect(await readFile(record.report_path as string, "utf8")).toBe(report);
    const provenance = JSON.parse(
      await readFile(provenancePath(record.report_path as string), "utf8"),
    );
    expect(provenance).toMatchObject({ sourcePath: record.report_source_path, machineId: "local" });
    expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
  });

  test("keeps a flexible report while discarding scratch work", async () => {
    const { fake, messages, instance, reportPath, reportSourcePath } = await launchedScout();
    const report = "# Evidence-led result\n\nFinding stands.\n\nOpen decision: choose A or B.";
    await writeFile(reportSourcePath, report);
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
    await instance.runProjects({ op: "remove", name: "fixture" });
    expect(await readFile(reportPath, "utf8")).toBe(report);
  });

  test("retains scouts with missing, empty, or non-regular reports", async () => {
    for (const prepare of [
      async (_path: string) => {},
      async (path: string) => {
        await writeFile(path, " \n");
      },
      async (path: string) => {
        await mkdir(path);
      },
    ]) {
      const launched = await launchedScout();
      await prepare(launched.reportSourcePath);
      launched.fake.settle("scout");
      await eventually(() => expect(launched.messages.length).toBe(1));
      expect(
        JSON.parse(launched.messages[0]!.message.slice("Visible worker result:\n".length)),
      ).toMatchObject({ status: "failed" });
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
  });

  test("rejects research inside a registered project before creating a space", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, [], undefined, join(project, "research"));
    await writeFile(join(root, ".omp", "projects.json"), JSON.stringify({ fixture: project }));
    const result = await instance.runTask({
      scope: "independent",
      context: "",
      tasks: [{ kind: "scout", name: "outside", task: "Research" }],
    });
    expect(result.details).toMatchObject([{ status: "failed" }]);
    expect(
      fake.calls.some((call) => call.command === "herdr" && call.args.includes("create")),
    ).toBe(false);
  });

  test("launches concurrently without registry, Git, or Treehouse", async () => {
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
    expect(launched.fake.workspaces.filter((space) => space.label === "research")).toHaveLength(1);
    expect(launched.fake.status.get("pane:first")).toBe("working");
    expect(launched.fake.status.get("pane:second")).toBe("working");
    expect(launched.fake.status.get("pane:third")).toBe("working");
  });

  test("settles reports before removing the neutral directory", async () => {
    const launched = await launchedIndependent();
    const record = (launched.result.details as Array<Record<string, unknown>>)[0];
    const reportPath = record.report_path as string;
    const directory = record.working_directory as string;
    const report = "# Vendor research\n\nResearch date: 2026-08-02\n\nSource: https://example.com";
    await writeFile(record.report_source_path as string, report);
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

describe("launch options", () => {
  test("warns when a start is behind its remote without fetching", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.upstreams.set("refs/heads/main", "origin refs/heads/main");
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const launch = async (name: string) =>
      (
        (
          await instance.runTask({
            project: "fixture",
            context: "",
            tasks: [{ kind: "scout", name, task: "Investigate" }],
          })
        ).details as Array<Record<string, unknown>>
      )[0]!.origin_warning;

    fake.remoteHeads.set("refs/heads/main", "remote1");
    fake.knownCommits.add("remote1");
    expect(await launch("fetched")).toContain("3 commit(s) behind origin/main");
    fake.knownCommits.clear();
    expect(await launch("unfetched")).toContain("never fetched");
    fake.knownCommits.add("remote1");
    fake.ancestors.add(`remote1:${fake.projectHead}`);
    expect(await launch("ahead")).toBeUndefined();
    fake.remoteHeads.set("refs/heads/main", fake.projectHead);
    expect(await launch("current")).toBeUndefined();
    expect(
      fake.calls.some(
        (call) =>
          call.command === "git" && (call.args.includes("fetch") || call.args.includes("pull")),
      ),
    ).toBe(false);
  });

  test("rejects hold on scouts", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await register(instance, project);
    const result = await instance.runTask({
      project: "fixture",
      context: "",
      tasks: [{ kind: "scout", name: "held", task: "work", hold: true }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type === "text" && result.content[0]!.text).toContain(
      "Only implementation",
    );
    expect(fake.calls.some((call) => call.command === "treehouse")).toBe(false);
  });
});

describe("target-bound launch journal", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0)) await close();
  });
  const fixture = async () => {
    const f = await launchFixture();
    cleanups.push(f.close);
    return f;
  };
  const projectTask = (name: string) => ({
    project: "repo",
    context: "Research only",
    tasks: [{ kind: "scout" as const, name, task: "Inspect the source", startFrom: "research" }],
  });

  test("refuses Claude Code workers on a remote machine before allocating", async () => {
    const f = await fixture();
    await f.registerRemote();
    const result = await f.run({
      project: "repo",
      context: "Research only",
      tasks: [{ kind: "scout", name: "remote-claude", task: "Inspect", agent: "claude" }],
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("only on the local machine");
    expect(f.hosts.get("remote")!.state.allocated).toBe(0);
    expect(f.state.store.all()).toEqual([]);
  });

  test("rejects project machine overrides before resources and honors independent default/override", async () => {
    const f = await fixture();
    await f.registerRemote();
    expect(f.tool.parameters.safeParse({ ...projectTask("bad"), machine: "local" }).success).toBe(
      false,
    );
    expect((await f.run({ ...projectTask("bad"), machine: "local" })).isError).toBe(true);
    expect(f.hosts.get("remote")!.state.allocated).toBe(0);
    expect(f.state.store.all()).toEqual([]);
    const remote = f.hosts.get("remote")!;
    f.state.store.setIndependentTarget({
      machineId: "remote",
      sshTarget: "remote-ssh",
      session: "agents",
      hostId: remote.hostId,
    });
    const independent = (name: string, machine?: string) => ({
      scope: "independent",
      context: "",
      ...(machine ? { machine } : {}),
      tasks: [{ kind: "scout", name, task: "Research public data" }],
    });
    const defaultResult = await f.run(independent("default"));
    const localResult = await f.run(independent("override", "local"));
    expect(defaultResult.details).toMatchObject([
      { machine: "remote", phase: "running", model: "openai-codex/remote", thinking: "high" },
    ]);
    expect(localResult.details).toMatchObject([
      { machine: "local", phase: "running", model: "openai-codex/local" },
    ]);
    expect(remote.state.panes.get("pane-0")!.prompts).toBe(1);
    expect(f.hosts.get("local")!.state.panes.get("pane-0")!.prompts).toBe(1);
  });

  test("captures only the host committed branch, excluding dirty files and leaving controller unchanged", async () => {
    const f = await fixture();
    await f.registerRemote();
    const remote = f.hosts.get("remote")!;
    await writeFile(join(remote.project, "uncommitted.txt"), "host-only dirty content");
    await writeFile(join(f.controller, "source.txt"), "controller unrelated");
    const result = await f.run(projectTask("remote-source"));
    expect(result.isError).toBeUndefined();
    const record = f.state.store.all()[0]!;
    expect(record.source_head).toBe(remote.researchHead);
    expect(await f.git(record.worktree!, ["rev-parse", "HEAD"])).toBe(remote.researchHead);
    expect(await readFile(join(record.worktree!, "source.txt"), "utf8")).toBe("remote research\n");
    expect(
      await lstat(join(record.worktree!, "uncommitted.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(record.local_changes).toContain("uncommitted.txt");
    expect(await readFile(join(f.controller, "source.txt"), "utf8")).toBe("controller unrelated");
    expect(await f.git(remote.project, ["rev-parse", "HEAD"])).toBe(remote.sourceHead);
    expect(record.report_path).toStartWith(join(f.controller, ".omp", "reports", "repo"));
    expect(record.report_source_path).toStartWith(remote.runtime.configuration.runtimeRoot);
    expect(record.report_source_path).not.toBe(record.report_path);
    expect(record.agent_binding?.agentName).toBe(record.agent_name);
    expect(remote.state.panes.get(record.pane_id!)!.model).toBe(record.model);
    expect(
      f.state.store
        .operations({ name: record.name, launchId: record.launch_id })
        .every((op) => op.state === "confirmed"),
    ).toBe(true);
  });

  test("missing prerequisites fail before acquisition; lease catalog mismatch returns only unused owned lease", async () => {
    const f = await fixture();
    await f.registerRemote();
    const remote = f.hosts.get("remote")!;
    remote.state.missing = true;
    expect((await f.run(projectTask("missing"))).isError).toBe(true);
    expect(remote.state.allocated).toBe(0);
    expect(f.state.store.all()).toEqual([]);
    remote.state.missing = false;
    remote.state.modelMismatch = true;
    const now = new Date().toISOString();
    f.state.store.saveOperation({
      id: randomUUID(),
      launchId: randomUUID(),
      workerName: "mismatch",
      channel: "helper",
      operation: "worker.allocate",
      requestHash: "0".repeat(64),
      state: "uncertain",
      createdAt: now,
      updatedAt: now,
    });
    const result = await f.run(projectTask("mismatch"));
    expect(result.details).toMatchObject([{ status: "failed" }]);
    expect(remote.state.allocated).toBe(1);
    expect(remote.state.returned).toBe(1);
    expect(remote.state.leases).toEqual([]);
    expect(remote.state.panes.size).toBe(0);
    expect(f.state.store.all()).toEqual([]);
    expect(f.state.store.operations()).toEqual([]);
  });

  for (const [lost, phase, operation] of [
    ["allocate", "allocating", "worker.allocate"],
    ["open", "opening_space", "worker.open"],
    ["start", "starting_agent", "agent.start"],
    ["prompt", "submitting_prompt", "agent.prompt"],
  ]) {
    test(`lost ${lost} acknowledgement retains a reserved recoverable launch without replay`, async () => {
      const f = await fixture();
      await f.registerRemote();
      const remote = f.hosts.get("remote")!;
      remote.state.lost = lost!;
      const result = await f.run(projectTask("uncertain"));
      expect(result.details).toMatchObject([{ status: "starting", phase }]);
      const stored = new WorkerStore(join(f.controller, ".omp", "orchestrator.db"));
      const record = stored.all()[0]!;
      expect(record.phase).toBe(phase);
      expect(
        stored
          .operations({ name: record.name, launchId: record.launch_id })
          .find((op) => op.operation === operation)?.state,
      ).toBe("uncertain");
      stored.close();
      expect(remote.state.allocated).toBe(1);
      expect(remote.state.returned).toBe(0);
      const prompts = [...remote.state.panes.values()].reduce((sum, pane) => sum + pane.prompts, 0);
      expect(prompts).toBe(lost === "prompt" ? 1 : 0);
      disposeWorkers(f.state);
      const restartedApi = { ...f.api };
      const restartedState = stateFor(restartedApi);
      expect((await runTask(restartedState, f.controller, projectTask("uncertain"))).isError).toBe(
        true,
      );
      expect(remote.state.allocated).toBe(1);
      expect([...remote.state.panes.values()].reduce((sum, pane) => sum + pane.prompts, 0)).toBe(
        prompts,
      );
      disposeWorkers(restartedState);
      restartedState.store.close();
    });
  }

  test("legacy local registration is validated and gains a durable path identity at launch", async () => {
    const f = await fixture();
    const local = f.hosts.get("local")!;
    await writeFile(
      join(f.controller, ".omp", "projects.json"),
      JSON.stringify({ repo: local.project }),
    );
    const result = await f.run({
      project: "repo",
      context: "",
      tasks: [{ kind: "scout", name: "legacy", task: "Inspect" }],
    });
    expect(result.details).toMatchObject([{ machine: "local", phase: "running" }]);
    const registry = JSON.parse(
      await readFile(join(f.controller, ".omp", "projects.json"), "utf8"),
    );
    expect(registry.version).toBe(2);
    expect(registry.projects.repo.pathKey).toBe(f.state.store.all()[0]!.project_path_key);
    expect(await f.git(local.project, ["rev-parse", "HEAD"])).toBe(local.sourceHead);
  });

  test("unknown prototype project names fail before acquiring resources", async () => {
    const f = await fixture();
    await f.registerRemote();
    const result = await f.run({ ...projectTask("prototype"), project: "constructor" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject([
      { text: expect.stringContaining("Unknown registered project: constructor") },
    ]);
    expect(f.state.store.all()).toEqual([]);
    expect(f.hosts.get("local")!.state.allocated).toBe(0);
    expect(f.hosts.get("remote")!.state.allocated).toBe(0);
  });

  for (const siblingState of ["deleted", "changed"] as const) {
    test(`${siblingState} sibling registration permits project and independent launches`, async () => {
      const f = await fixture();
      await f.registerRemote();
      const remote = f.hosts.get("remote")!;
      const sibling = join(remote.root, "projects", "sibling");
      await mkdir(sibling);
      const identity = await canonicalPath(sibling);
      const registryPath = join(f.controller, ".omp", "projects.json");
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      registry.projects.sibling = {
        ...registry.projects.repo,
        path: identity.path,
        pathKey: siblingState === "changed" ? `${identity.pathKey}-old` : identity.pathKey,
      };
      await writeFile(registryPath, JSON.stringify(registry));
      if (siblingState === "deleted") await rm(sibling, { recursive: true });
      const project = await f.run(projectTask("healthy"));
      expect(project.details).toMatchObject([{ machine: "remote", phase: "running" }]);
      const independent = await f.run({
        scope: "independent",
        machine: "remote",
        context: "",
        tasks: [{ kind: "scout", name: "independent", task: "Inspect public data" }],
      });
      expect(independent.details).toMatchObject([{ machine: "remote", phase: "running" }]);
      expect(f.state.store.all()).toHaveLength(2);
    });
  }

  test("changed launched project identity still refuses acquisition", async () => {
    const f = await fixture();
    await f.registerRemote();
    const registryPath = join(f.controller, ".omp", "projects.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.projects.repo.pathKey += "-old";
    await writeFile(registryPath, JSON.stringify(registry));
    expect((await f.run(projectTask("changed"))).isError).toBe(true);
    expect(f.hosts.get("remote")!.state.allocated).toBe(0);
    expect(f.state.store.all()).toEqual([]);
  });
});

describe("startup ownership boundaries", () => {
  for (const lostPrompt of [false, true]) {
    test(`${lostPrompt ? "unacknowledged" : "acknowledged"} idle startup is supervised through same-session completion without replay`, async () => {
      const f = await launchFixture();
      vi.useFakeTimers();
      try {
        const local = f.hosts.get("local")!;
        local.state.idleAfterPrompt = true;
        if (lostPrompt) local.state.lost = "prompt";
        await writeFile(
          join(f.controller, ".omp", "projects.json"),
          JSON.stringify({ repo: local.project }),
        );
        const result = await f.run({
          project: "repo",
          context: "",
          tasks: [{ kind: "scout", name: "later", task: "Inspect" }],
        });
        expect(result.details).toMatchObject([{ status: "starting", phase: "submitting_prompt" }]);
        const record = f.state.records.get("later")!;
        const pane = local.state.panes.get(record.pane_id!)!;
        await writeFile(record.report_source_path!, "# Findings\nCompleted in this session.\n");
        for (let turn = 0; turn < 40; turn++) await new Promise<void>(setImmediate);
        expect(record.status).toBe("starting");
        expect(local.state.returned).toBe(0);
        pane.status = "done";
        pane.completionSeq = 1;
        vi.advanceTimersByTime(60_000);
        await eventually(() => {
          expect(f.state.records.has("later")).toBe(false);
        });
        expect(await readFile(record.report_path!, "utf8")).toContain("Completed in this session.");
        expect(local.state.returned).toBe(1);
        expect(pane.prompts).toBe(1);
        expect(f.state.store.operations()).toEqual([]);
      } finally {
        await f.close();
        vi.useRealTimers();
      }
    });
  }

  test("overlapping concurrent batches refuse every name in the losing batch before launch", async () => {
    const f = await launchFixture();
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let first: Promise<ToolOutcome> | undefined;
    let second: Promise<ToolOutcome> | undefined;
    try {
      await f.registerRemote();
      const remote = f.hosts.get("remote")!;
      let snapshots = 0;
      remote.state.beforeSnapshot = () => {
        const index = snapshots++;
        entered[index]!.resolve();
        return gates[index]!.promise;
      };
      const params = (names: string[]) => ({
        project: "repo",
        context: "",
        tasks: names.map((name) => ({ kind: "scout", name, task: "Inspect" })),
      });
      first = f.run(params(["shared"]));
      await entered[0]!.promise;
      second = f.run(params(["unique", "shared"]));
      await entered[1]!.promise;
      gates[0]!.resolve();
      expect((await first).isError).toBeUndefined();
      gates[1]!.resolve();
      expect((await second).isError).toBe(true);
      expect(f.state.store.all().map((record) => record.name)).toEqual(["shared"]);
      expect(remote.state.allocated).toBe(1);
      expect(remote.state.panes.size).toBe(1);
    } finally {
      for (const gate of gates) gate.resolve();
      await Promise.all([first, second]);
      await f.close();
    }
  });

  test("idle startup never settles a local scout and never replays its acknowledged prompt", async () => {
    const f = await launchFixture();
    try {
      const local = f.hosts.get("local")!;
      local.state.idleAfterPrompt = true;
      await writeFile(
        join(f.controller, ".omp", "projects.json"),
        JSON.stringify({ repo: local.project }),
      );
      const result = await f.run({
        project: "repo",
        context: "",
        tasks: [{ kind: "scout", name: "idle", task: "Inspect" }],
      });
      expect(result.details).toMatchObject([{ status: "starting", phase: "submitting_prompt" }]);
      const record = f.state.store.all()[0]!;
      expect(
        f.state.store
          .operations({ name: record.name, launchId: record.launch_id })
          .find((op) => op.operation === "agent.prompt")?.state,
      ).toBe("confirmed");
      expect(local.state.returned).toBe(0);
      expect(local.state.panes.get(record.pane_id!)!.prompts).toBe(1);
      expect(
        await lstat(record.report_path!).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        (
          await f.run({
            project: "repo",
            context: "",
            tasks: [{ kind: "scout", name: "idle", task: "Inspect" }],
          })
        ).isError,
      ).toBe(true);
      expect(local.state.panes.get(record.pane_id!)!.prompts).toBe(1);
    } finally {
      await f.close();
    }
  });

  test("simultaneous calls reserve one name before allocating and a batch stays on one host", async () => {
    const f = await launchFixture();
    try {
      await f.registerRemote();
      const params = {
        project: "repo",
        context: "",
        tasks: [{ kind: "scout", name: "same", task: "Inspect" }],
      };
      const results = await Promise.all([f.run(params), f.run(params)]);
      expect(results.filter((result) => result.isError)).toHaveLength(1);
      const remote = f.hosts.get("remote")!;
      expect(remote.state.allocated).toBe(1);
      expect(f.state.store.all()).toHaveLength(1);
      const batch = await f.run({
        project: "repo",
        context: "",
        tasks: [
          { kind: "scout", name: "first", task: "Inspect" },
          { kind: "scout", name: "second", task: "Inspect" },
        ],
      });
      expect(batch.details).toMatchObject([
        { machine: "remote", phase: "running" },
        { machine: "remote", phase: "running" },
      ]);
      expect(remote.state.allocated).toBe(3);
      expect(f.hosts.get("local")!.state.allocated).toBe(0);
    } finally {
      await f.close();
    }
  });
});

test("launches when OMP advertises a future session filename before the first prompt", async () => {
  const f = await launchFixture();
  try {
    await f.registerRemote();
    const remote = f.hosts.get("remote")!;
    remote.state.futureSessionPath = join(remote.root, "omp", "sessions", "future.jsonl");
    const result = await f.run({
      project: "repo",
      context: "",
      tasks: [{ kind: "scout", name: "future-session", task: "Inspect" }],
    });
    expect(result.details).toMatchObject([{ status: "working", phase: "running" }]);
    const record = f.state.store.all()[0]!;
    expect(remote.state.panes.get(record.pane_id!)!.prompts).toBe(1);
    expect(
      f.state.store
        .operations({ name: record.name, launchId: record.launch_id })
        .find((op) => op.operation === "worker.bind-agent")?.state,
    ).toBe("confirmed");
    expect(
      await lstat(remote.state.futureSessionPath).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
