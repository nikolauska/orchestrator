import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, FakeExec, fixtureRoot, fixtureHost, runtime } from "./test-helpers";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import modelsTool from "../src/tools/models";
import {
  effectiveWorkerChoice,
  selectOmpContext,
  selectedModels,
  type OmpContextResolver,
  type OmpQueryAPI,
} from "../src/runtime/omp";
import { createHostRuntime, dispatchHostRequest } from "../src/runtime/host";
import type { HostReply, HostRequest } from "../src/runtime/helper-protocol";
import type { StdioSpawn, RuntimeDeps } from "../src/runtime/shared";
import { executionTargetFixture } from "./test-helpers";
import { resolveMachineOmpContext } from "../src/runtime/machines";

afterEach(cleanup);

const CATALOG = [
  {
    provider: "anthropic",
    kind: "chat",
    id: "claude-opus-5-5",
    selector: "anthropic/claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinking: ["low", "medium", "high", "max"],
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5 },
  },
  {
    provider: "anthropic",
    kind: "chat",
    id: "claude-haiku-4-5",
    selector: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    thinking: ["low", "high"],
    input: ["text"],
  },
  {
    provider: "openai-codex",
    kind: "chat",
    id: "gpt-5.6",
    selector: "openai-codex/gpt-5.6",
    name: "GPT-5.6",
    thinking: ["low", "high", "xhigh"],
    input: ["text"],
  },
  {
    provider: "openrouter",
    kind: "chat",
    id: "qwen/qwen3-coder:free",
    selector: "openrouter/qwen/qwen3-coder:free",
    thinking: null,
    input: ["text"],
  },
];

async function setup(roles: Record<string, string> = {}) {
  const { root, project } = await fixtureRoot();
  const fake = new FakeExec(project);
  fake.models = CATALOG;
  fake.modelRoles = { default: "anthropic/claude-opus-5-5", ...roles };
  const exec = fake.exec;
  fake.exec = (command, args, options) =>
    exec(
      command,
      command === "omp" ? args.filter((arg) => !arg.startsWith("--config=")) : args,
      options,
    );
  return { root, fake, instance: runtime(root, fake, []) };
}

type Listed = {
  view: string;
  total: number;
  returned: number;
  models: Array<{ model: string; roles?: string[]; preference?: { stance: string } }>;
  issues?: string[];
};

describe("models", () => {
  test("preferred view ranks saved preferences, role targets, and avoided models", async () => {
    const { instance } = await setup({
      default: "anthropic/claude-opus-5-5:high",
      slow: "@default",
      tiny: "anthropic/claude-haiku-4-5",
      broken: "pi/missing",
    });
    for (const params of [
      { op: "prefer" as const, model: "openai-codex/gpt-5.6:xhigh", rank: 2, for: ["review"] },
      { op: "prefer" as const, model: "anthropic/claude-opus-5-5:max", rank: 1, note: "hard bugs" },
      { op: "avoid" as const, model: "anthropic/claude-haiku-4-5", note: "misses edge cases" },
      { op: "prefer" as const, model: "openrouter/qwen/qwen3-coder:free" },
    ])
      expect((await instance.runModels(params)).isError).toBeUndefined();

    const listed = (await instance.runModels({ op: "list" })).details as Listed;

    expect(listed.models.map((item) => item.model)).toEqual([
      "anthropic/claude-opus-5-5:max",
      "openai-codex/gpt-5.6:xhigh",
      "openrouter/qwen/qwen3-coder:free",
      "anthropic/claude-opus-5-5:high",
      "anthropic/claude-haiku-4-5",
    ]);
    // Aliased roles resolve to the model they really run; the avoided model keeps its role.
    expect(listed.models[3]).toMatchObject({ roles: ["default", "slow"] });
    expect(listed.models[4]).toMatchObject({
      roles: ["tiny"],
      preference: { stance: "avoid", note: "misses edge cases" },
    });
    expect(listed.models[0]).toMatchObject({
      provider: "anthropic",
      name: "Claude Opus 5.5",
      context_window: 1_000_000,
      cost_per_mtok: { input: 5, output: 25 },
      preference: { stance: "prefer", rank: 1, note: "hard bugs" },
    });
    expect(listed.issues).toEqual([expect.stringContaining("pi/missing")]);
  });

  test("all view searches the whole catalog by provider and text", async () => {
    const { instance } = await setup();
    await instance.runModels({ op: "prefer", model: "openai-codex/gpt-5.6", for: ["review"] });

    const all = (await instance.runModels({ op: "list", view: "all", limit: 2 })).details as Listed;
    expect(all).toMatchObject({ total: 4, returned: 2 });
    expect(all.models[0]!.model).toBe("openai-codex/gpt-5.6");

    const anthropic = (await instance.runModels({ op: "list", view: "all", provider: "Anthropic" }))
      .details as Listed;
    expect(anthropic.models.map((item) => item.model)).toEqual([
      "anthropic/claude-opus-5-5",
      "anthropic/claude-haiku-4-5",
    ]);

    const review = (await instance.runModels({ op: "list", view: "all", q: "REVIEW" }))
      .details as Listed;
    expect(review.models.map((item) => item.model)).toEqual(["openai-codex/gpt-5.6"]);
  });

  test("saving rejects unknown models and thinking levels without writing", async () => {
    const { root, instance } = await setup();

    const typo = await instance.runModels({ op: "prefer", model: "anthropic/claude-opus-55" });
    expect(typo.isError).toBe(true);
    const level = await instance.runModels({ op: "avoid", model: "openai-codex/gpt-5.6:max" });
    expect(level.isError).toBe(true);

    await expect(readFile(join(root, ".omp", "model-preferences.json"))).rejects.toThrow();
  });

  test("a later save replaces the entry and forget removes it", async () => {
    const { root, instance } = await setup();
    const model = "anthropic/claude-opus-5-5:high";
    await instance.runModels({ op: "prefer", model, rank: 1, for: ["plan"], note: "planning" });
    await instance.runModels({ op: "avoid", model });

    const saved = JSON.parse(await readFile(join(root, ".omp", "model-preferences.json"), "utf8"));
    expect(saved).toEqual({ [model]: { stance: "avoid", updated_at: expect.any(String) } });

    expect((await instance.runModels({ op: "forget", model })).isError).toBeUndefined();
    expect((await instance.runModels({ op: "list" })).details).toMatchObject({
      models: [{ model: "anthropic/claude-opus-5-5" }],
    });
    const again = await instance.runModels({ op: "forget", model });
    expect(again.isError).toBe(true);
  });

  test("stale preferences are reported and can still be forgotten", async () => {
    const { root, instance } = await setup();
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(
      join(root, ".omp", "model-preferences.json"),
      JSON.stringify({ "retired/model": { stance: "prefer", updated_at: "2026-01-01" } }),
    );

    const listed = (await instance.runModels({ op: "list" })).details as Listed;
    expect(listed.models).toMatchObject([{ model: "anthropic/claude-opus-5-5" }]);
    expect(listed.issues).toEqual([expect.stringContaining("retired/model")]);
    expect((await instance.runModels({ op: "forget", model: "retired/model" })).isError).toBe(
      undefined,
    );
  });

  test("a malformed preferences file is an error, not an empty list", async () => {
    const { root, instance } = await setup();
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(
      join(root, ".omp", "model-preferences.json"),
      JSON.stringify({ "openai-codex/gpt-5.6": { stance: "maybe", updated_at: "x" } }),
    );

    const result = await instance.runModels({ op: "list" });
    expect(result.isError).toBe(true);
  });
});

async function hostModelsFixture() {
  const { root, project } = await fixtureRoot();
  const remoteRoot = join(root, "host");
  const queryCwd = join(remoteRoot, "query");
  const leaseCwd = join(remoteRoot, "lease");
  await mkdir(queryCwd, { recursive: true });
  await mkdir(leaseCwd);
  await mkdir(join(remoteRoot, "runtime"));
  await mkdir(join(remoteRoot, "neutral"));
  const overlayPath = join(remoteRoot, "worker.yml");
  await writeFile(overlayPath, "settings: {}\n");
  const overlaySha256 = createHash("sha256")
    .update(await readFile(overlayPath))
    .digest("hex");
  const target = {
    ...executionTargetFixture("linux", "remote"),
    ompProfile: "remote-profile",
    workerConfig: { path: overlayPath, sha256: overlaySha256 },
  };
  const context = { cwd: queryCwd, ompProfile: target.ompProfile, overlayPath, overlaySha256 };
  const controllerId = crypto.randomUUID();
  const catalog = [
    {
      selector: "remote/only",
      provider: "remote",
      id: "only",
      kind: "chat",
      thinking: ["low", "high"],
      input: ["text"],
    },
    {
      selector: "remote/lease",
      provider: "remote",
      id: "lease",
      kind: "chat",
      thinking: ["high"],
      input: ["text"],
    },
    {
      selector: "openrouter/model:free",
      provider: "openrouter",
      id: "model:free",
      kind: "chat",
      thinking: [],
      input: ["text"],
    },
  ];
  const roles = { default: "remote/only:low", slow: "@default:high" };
  const host = createHostRuntime(
    {
      version: 1,
      hostId: target.hostId,
      queryCwd,
      overlayPath,
      runtimeRoot: join(remoteRoot, "runtime"),
      neutralRoot: join(remoteRoot, "neutral"),
      approvedProjectRoots: [],
      ompProfile: target.ompProfile,
      executables: Object.fromEntries(
        ["omp", "git", "treehouse"].map((name) => [name, { executable: name, prefixArgs: [] }]),
      ) as {
        omp: { executable: string; prefixArgs: string[] };
        git: { executable: string; prefixArgs: string[] };
        treehouse: { executable: string; prefixArgs: string[] };
      },
    },
    {
      exec: async (_command, args, options) => {
        if (!args.includes("remote-profile")) throw new Error("Wrong host profile");
        const value = args.includes("models")
          ? { models: catalog }
          : {
              value: options?.cwd === leaseCwd ? { ...roles, default: "remote/lease:high" } : roles,
            };
        return { code: 0, stdout: JSON.stringify(value), stderr: "" };
      },
      logger: {} as RuntimeDeps["logger"],
      notify() {},
    },
    { discoverExecutable: () => process.execPath },
  );
  let online = true;
  const spawnStdio: StdioSpawn = () => {
    if (!online) throw new Error("Host offline");
    let input = "";
    let finish!: (reply: HostReply) => void;
    const reply = new Promise<HostReply>((resolve) => {
      finish = resolve;
    });
    return {
      stdin: {
        write(data) {
          input += new TextDecoder().decode(
            typeof data === "string" ? new TextEncoder().encode(data) : data,
          );
        },
        async end() {
          finish(await dispatchHostRequest(host, JSON.parse(input) as HostRequest));
        },
      },
      stdout: (async function* () {
        yield new TextEncoder().encode(`${JSON.stringify(await reply)}\n`);
      })(),
      stderr: (async function* () {})(),
      exited: reply.then(() => 0),
      kill() {},
    };
  };
  const local = new FakeExec(project);
  local.models = CATALOG;
  local.modelRoles = { default: "anthropic/claude-opus-5-5:high" };
  const resolver: OmpContextResolver = async (machine) => {
    if (!online) throw new Error("Host offline");
    if (machine === "local") return resolveMachineOmpContext(pi, machine, { controllerId });
    if (machine !== target.machineId) throw new Error("Unknown machine");
    return { target, context, controllerId };
  };
  const pi: OmpQueryAPI = {
    cwd: root,
    zod,
    logger: {} as RuntimeDeps["logger"],
    notify() {},
    exec: (command, args, options) =>
      local.exec(
        command,
        command === "omp" ? args.filter((arg) => !arg.startsWith("--config=")) : args,
        options,
      ),
    spawnStdio,
    resolveOmpContext: resolver,
  };
  pi.localHostRuntime = fixtureHost(root, pi);
  const tool = modelsTool(pi);
  const run = (params: unknown) => tool.execute(params);
  return {
    root,
    pi,
    run,
    target,
    context,
    leaseCwd,
    roles,
    offline() {
      online = false;
    },
  };
}

describe("host-qualified models", () => {
  test("validates a remote-only preference on its host, retains it on another host, and forgets offline", async () => {
    const fixture = await hostModelsFixture();
    const saved = await fixture.run({
      op: "prefer",
      machine: "remote",
      model: "remote/only:high",
      for: ["review"],
      rank: 1,
    });
    expect(saved).not.toHaveProperty("isError", true);
    expect(saved.details).toMatchObject({
      model: "remote/only:high",
      machine: "remote",
      session: "agents",
      os: "linux",
      configuration_context: fixture.context,
      observed_at: expect.any(String),
    });
    const persisted = JSON.parse(
      await readFile(join(fixture.root, ".omp", "model-preferences.json"), "utf8"),
    );
    expect(persisted["remote/only:high"]).toMatchObject({
      stance: "prefer",
      rank: 1,
      for: ["review"],
    });
    const remote = await fixture.run({ op: "list", machine: "remote" });
    expect(remote.details).toMatchObject({
      models: [
        { model: "remote/only:high", roles: ["slow"], preference: { stance: "prefer" } },
        { model: "remote/only:low", roles: ["default"] },
      ],
    });
    const local = await fixture.run({ op: "list" });
    expect(local.details).toMatchObject({
      machine: "local",
      issues: [expect.stringContaining("remote/only:high")],
    });
    expect(
      JSON.parse(await readFile(join(fixture.root, ".omp", "model-preferences.json"), "utf8")),
    ).toEqual(persisted);
    fixture.offline();
    expect(
      (await fixture.run({ op: "forget", model: "remote/only:high" })).isError,
    ).toBeUndefined();
    expect(
      JSON.parse(await readFile(join(fixture.root, ".omp", "model-preferences.json"), "utf8")),
    ).toEqual({});
  });

  test("refuses invalid host selectors and model/thinking choices without remembering them", async () => {
    const fixture = await hostModelsFixture();
    for (const params of [
      { op: "prefer", machine: "remote", model: "remote/on" },
      { op: "avoid", machine: "remote", model: "remote/only:max" },
      { op: "prefer", machine: "remote", project: "app", model: "remote/only" },
      { op: "prefer", machine: " ", model: "remote/only" },
      { op: "avoid", project: "missing", model: "remote/only" },
    ])
      expect((await fixture.run(params)).isError).toBe(true);
    await expect(readFile(join(fixture.root, ".omp", "model-preferences.json"))).rejects.toThrow();
    expect(
      modelsTool(fixture.pi).parameters.safeParse({ op: "list", machine: "remote", project: "app" })
        .success,
    ).toBe(false);
    expect(
      modelsTool(fixture.pi).parameters.safeParse({
        op: "forget",
        machine: "remote",
        model: "remote/only",
      }).success,
    ).toBe(false);
  });

  test("project queries use registered host cwd, reject retargeted binding, and do not migrate on read", async () => {
    const fixture = await hostModelsFixture();
    const registry = {
      version: 2,
      roots: {},
      projects: {
        app: {
          machine: fixture.target.machineId,
          path: fixture.leaseCwd,
          pathKey: "lease",
          binding: {
            hostId: fixture.target.hostId,
            sshTarget: fixture.target.sshTarget,
            session: fixture.target.session,
          },
        },
      },
    };
    await mkdir(join(fixture.root, ".omp"), { recursive: true });
    const registryPath = join(fixture.root, ".omp", "projects.json");
    const bytes = JSON.stringify(registry);
    await writeFile(registryPath, bytes);
    const result = await fixture.run({ op: "list", project: "app" });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      machine: "remote",
      configuration_context: { ...fixture.context, cwd: fixture.leaseCwd },
      models: [expect.objectContaining({ model: "remote/lease:high", roles: ["default", "slow"] })],
    });
    expect(await readFile(registryPath, "utf8")).toBe(bytes);
    registry.projects.app.binding.session = "other";
    await writeFile(registryPath, JSON.stringify(registry));
    expect((await fixture.run({ op: "list", project: "app" })).isError).toBe(true);
  });

  test("resolves the host default and alias thinking, then revalidates in the reset lease context", async () => {
    const fixture = await hostModelsFixture();
    const selected = await selectOmpContext(fixture.pi, { machine: "remote" });
    const snapshot = await selectedModels(fixture.pi, selected);
    expect(await effectiveWorkerChoice(snapshot, snapshot.context)).toEqual({
      model: "remote/only",
      thinking: "low",
    });
    expect(await effectiveWorkerChoice(snapshot, snapshot.context, { role: "slow" })).toEqual({
      model: "remote/only",
      thinking: "high",
    });
    expect(
      await effectiveWorkerChoice(snapshot, snapshot.context, { model: "openrouter/model:free" }),
    ).toEqual({ model: "openrouter/model:free" });
    await expect(
      effectiveWorkerChoice(snapshot, snapshot.context, { model: "remote/only:max" }),
    ).rejects.toThrow();
    await expect(
      effectiveWorkerChoice(snapshot, snapshot.context, { role: "missing" }),
    ).rejects.toThrow();
    await expect(
      effectiveWorkerChoice(snapshot, snapshot.context, { role: "slow", model: "remote/only" }),
    ).rejects.toThrow();
    const leaseContext = { ...fixture.context, cwd: fixture.leaseCwd };
    await expect(effectiveWorkerChoice(snapshot, leaseContext)).rejects.toThrow();
    const leaseSnapshot = await selectedModels(fixture.pi, {
      ...selected,
      configuration_context: leaseContext,
    });
    expect(await effectiveWorkerChoice(leaseSnapshot, leaseContext)).toEqual({
      model: "remote/lease",
      thinking: "high",
    });
    fixture.roles.default = "local/unavailable";
    expect((await fixture.run({ op: "list", machine: "remote" })).isError).toBe(true);
    delete (fixture.roles as Partial<typeof fixture.roles>).default;
    expect((await fixture.run({ op: "list", machine: "remote" })).isError).toBe(true);
  });
});

test("effective local choice preserves colon ids, refuses role cycles, and verifies overlay bytes", async () => {
  const { root, fake } = await setup({
    default: "openrouter/level:high",
    slow: "@default:low",
    cycle: "@other",
    other: "@cycle",
  });
  fake.models.push({
    selector: "openrouter/level:high",
    id: "level:high",
    provider: "openrouter",
    kind: "chat",
    thinking: ["low"],
    input: ["text"],
  });
  const pi: OmpQueryAPI = {
    cwd: root,
    zod,
    logger: {} as RuntimeDeps["logger"],
    notify() {},
    exec: fake.exec as RuntimeDeps["exec"],
  };
  pi.localHostRuntime = fixtureHost(root, pi);
  pi.resolveOmpContext = (machine, signal) =>
    resolveMachineOmpContext(pi, machine, { controllerId: crypto.randomUUID(), signal });
  const selected = await selectOmpContext(pi, {});
  expect(await effectiveWorkerChoice(pi, selected.configuration_context, { role: "slow" })).toEqual(
    { model: "openrouter/level:high", thinking: "low" },
  );
  await expect(
    effectiveWorkerChoice(pi, selected.configuration_context, { role: "cycle" }),
  ).rejects.toThrow();
  await expect(
    effectiveWorkerChoice(pi, { ...selected.configuration_context, overlaySha256: "0".repeat(64) }),
  ).rejects.toThrow();
});
