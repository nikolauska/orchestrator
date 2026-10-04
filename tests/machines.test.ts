import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WorkerStore } from "../.omp/runtime/store";
import type { MachineCheck } from "../.omp/runtime/machines";
import {
  cleanup,
  executionTargetFixture,
  fixtureRoot,
  machineFixture,
  runtime,
  extensionRuntime,
} from "./test-helpers";

afterEach(cleanup);
describe("machines", () => {
  test("lists local and saved profiles/default without probing either host channel", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, helperCalls, hosts } = await machineFixture(root, project);
    for (const host of hosts.values()) host.offline = true;
    const result = await instance.runMachines({ op: "list" });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      independent_default: { machineId: "local" },
      machines: expect.arrayContaining([
        expect.objectContaining({ machineId: "local" }),
        expect.objectContaining({ machineId: "workbox", session: "agents" }),
      ]),
      issues: [],
    });
    expect(helperCalls).toEqual([]);
  });

  test("status isolates an unavailable Herdr channel and does not need the helper", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, hosts, helperCalls } = await machineFixture(root, project);
    hosts.get("workbox-ssh")!.herdrOffline = true;
    hosts.get("windows-ssh")!.offline = true;
    const result = await instance.runMachines({ op: "status" });
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          machine: expect.objectContaining({ machineId: "workbox" }),
          herdr: expect.objectContaining({ state: "offline" }),
        }),
        expect.objectContaining({
          machine: expect.objectContaining({ machineId: "windows" }),
          herdr: { state: "online" },
        }),
      ]),
    );
    expect(helperCalls).toEqual([]);
  });

  test("check resolves a unique label and returns Windows host-native target and integration evidence", async () => {
    const { root, project } = await fixtureRoot();
    const { instance } = await machineFixture(root, project);
    const result = await instance.runMachines({ op: "check", machine: "Windows" });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      ready: true,
      herdr: { state: "online" },
      helper: { state: "online" },
      target: {
        machineId: "windows",
        kind: "ssh",
        os: "win32",
        session: "agents",
        workerConfig: { path: "D:\\OMP\\worker-config.yml" },
      },
      preflight: {
        tools: expect.arrayContaining([
          { name: "herdr-omp-integration", available: true, version: "3", capabilities: [] },
        ]),
      },
    });
  });

  test("checks both channels without turning offline into worker death or silently using local", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, hosts } = await machineFixture(root, project);
    hosts.get("workbox-ssh")!.offline = true;
    const failed = await instance.runMachines({ op: "check", machine: "workbox" });
    expect(failed.isError).toBe(true);
    expect(failed.details).toMatchObject({
      ready: false,
      herdr: { state: "online" },
      helper: expect.objectContaining({ state: "offline" }),
    });
    hosts.get("workbox-ssh")!.offline = false;
    hosts.get("workbox-ssh")!.herdrOffline = true;
    const terminalOffline = (await instance.runMachines({ op: "check", machine: "workbox" }))
      .details as MachineCheck;
    expect(terminalOffline.ready).toBe(false);
    expect(terminalOffline.helper.state).toBe("online");
    expect(terminalOffline.herdr.state).toBe("offline");
  });

  test("preflight refuses unapproved overlay bytes and old host integration", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, hosts } = await machineFixture(root, project);
    const host = hosts.get("workbox-ssh")!;
    const hash = host.overlaySha256;
    host.overlaySha256 = "0".repeat(64);
    expect((await instance.runMachines({ op: "check", machine: "workbox" })).details).toMatchObject(
      {
        ready: false,
        errors: expect.arrayContaining([expect.objectContaining({ code: "CONFIG_MISMATCH" })]),
      },
    );
    host.overlaySha256 = hash;
    host.integration = "2";
    expect((await instance.runMachines({ op: "check", machine: "workbox" })).details).toMatchObject(
      {
        ready: false,
        errors: expect.arrayContaining([expect.objectContaining({ code: "PREREQUISITE_MISSING" })]),
      },
    );
    expect((await instance.runMachines({ op: "list" })).details).toMatchObject({
      independent_default: { machineId: "local" },
    });
  });

  test("changing default persists only the independent selector and leaves retained workers unchanged", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, profiles, hosts } = await machineFixture(root, project);
    const store = new WorkerStore(join(root, ".omp", "orchestrator.db"));
    store.save({
      name: "retained",
      scope: "independent",
      kind: "scout",
      status: "starting",
      phase: "preflighted",
      generation: 0,
      target: executionTargetFixture(),
      agent_name: "o12345678-12345678123441238123",
    });
    const before = store.all();
    expect(
      (await instance.runMachines({ op: "set-default", machine: "Build machine" })).isError,
    ).toBeUndefined();
    expect(store.independentTarget).toEqual({
      machineId: "workbox",
      sshTarget: "workbox-ssh",
      session: "agents",
      hostId: hosts.get("workbox-ssh")!.hostId,
    });
    expect(store.all()).toEqual(before);
    profiles[0]!.label = "Renamed";
    expect(
      (await instance.runMachines({ op: "check", machine: "workbox" })).isError,
    ).toBeUndefined();
    profiles[0]!.session = "retargeted";
    expect((await instance.runMachines({ op: "set-default", machine: "workbox" })).isError).toBe(
      true,
    );
    expect(store.independentTarget).toMatchObject({ session: "agents" });
    profiles[0]!.session = "agents";
    hosts.get("workbox-ssh")!.hostId = "55555555-5555-4555-8555-555555555555";
    expect((await instance.runMachines({ op: "check", machine: "workbox" })).details).toMatchObject(
      {
        ready: false,
        errors: expect.arrayContaining([expect.objectContaining({ code: "HOST_MISMATCH" })]),
      },
    );
    expect(store.all()).toEqual(before);
    store.close();
  });

  test("missing and disabled saved bindings are visible offline without rebinding workers", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, profiles, helperCalls } = await machineFixture(root, project);
    await instance.runProjects({
      op: "add",
      name: "app",
      machine: "workbox",
      path: "/srv/projects/repo",
    });
    profiles[0]!.enabled = false;
    expect((await instance.runMachines({ op: "set-default", machine: "workbox" })).isError).toBe(
      true,
    );
    profiles.splice(0, 1);
    helperCalls.length = 0;
    const result = await instance.runMachines({ op: "list" });
    expect(result.details).toMatchObject({
      machines: expect.arrayContaining([
        expect.objectContaining({ machineId: "workbox", enabled: false }),
      ]),
      issues: expect.arrayContaining([
        expect.objectContaining({
          machine: "workbox",
          source: "project:app",
          error: expect.objectContaining({ code: "MACHINE_NOT_FOUND" }),
        }),
      ]),
    });
    expect(helperCalls).toEqual([]);
  });

  test("ambiguous labels and nonowner default writes are refused", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, fake, profiles } = await machineFixture(root, project);
    profiles[2]!.label = "Build machine";
    expect((await instance.runMachines({ op: "check", machine: "Build machine" })).isError).toBe(
      true,
    );
    expect(
      (await instance.runMachines({ op: "set-default", machine: "workbox" })).isError,
    ).toBeUndefined();
    const reader = runtime(root, fake, []);
    expect((await reader.runMachines({ op: "set-default", machine: "local" })).isError).toBe(true);
    expect((await reader.runMachines({ op: "list" })).details).toMatchObject({
      independent_default: { machineId: "workbox" },
    });
    instance.dispose();
    reader.dispose();
  });
});

describe("host-scoped OMP tools through extension wiring", () => {
  test("models and usage use each host's catalog/accounts and its registered Windows project context", async () => {
    const { root, project } = await fixtureRoot();
    const {
      fake,
      hosts,
      spawnStdio,
      instance: fixtureInstance,
    } = await machineFixture(root, project);
    fake.models.push({
      provider: "openrouter",
      kind: "chat",
      selector: "openrouter/auto",
      cost: { input: -1000000, output: -1000000 },
      thinking: [],
      input: ["text"],
    });
    const { instance } = extensionRuntime(root, fake, [], { spawnStdio });
    const host = hosts.get("windows-ssh")!;
    expect(
      (
        await instance.runProjects({
          op: "add",
          name: "win-app",
          machine: "windows",
          path: `${host.root}\\repo`,
        })
      ).isError,
    ).toBeUndefined();
    expect(
      (await instance.runModels({ op: "list", view: "all", machine: "Windows" })).details,
    ).toMatchObject({
      machine: "windows",
      os: "win32",
      models: [expect.objectContaining({ model: "openai-codex/win32-only" })],
    });
    expect(
      (await instance.runModels({ op: "list", view: "all", project: "win-app" })).details,
    ).toMatchObject({
      machine: "windows",
      configuration_context: expect.objectContaining({ cwd: `${host.root}\\repo` }),
      models: [expect.objectContaining({ model: "openai-codex/win32-only-project" })],
    });
    const usage = await instance.runUsage({ project: "win-app" });
    expect(usage.isError).toBeUndefined();
    expect(usage.details).toMatchObject({
      machine: "windows",
      roles: { default: "openai-codex/win32-only-project" },
      providers: [
        {
          provider: "openai-codex",
          roles: ["default"],
          accounts: [{ account: "win32*", windows: [] }],
          capacity: [{ window: "5h", accounts: 1, remaining_accounts: 0.73 }],
        },
      ],
    });
    expect((await instance.runUsage({ machine: "mac" })).details).toMatchObject({
      machine: "mac",
      providers: [expect.objectContaining({ accounts: [{ account: "darwin*", windows: [] }] })],
    });
    const localModels = (await instance.runModels({ op: "list", view: "all" })).details as {
      machine: string;
      models: { model: string; cost?: unknown }[];
    };
    expect(
      localModels.models.find((model) => model.model === "openrouter/auto"),
    ).not.toHaveProperty("cost");
    expect(localModels).toMatchObject({
      machine: "local",
      models: expect.arrayContaining([
        expect.objectContaining({ model: "anthropic/claude-opus-5-5" }),
      ]),
    });
    host.accounts = 1.5;
    expect((await instance.runUsage({ machine: "windows" })).isError).toBe(true);
    instance.dispose();
    fixtureInstance.dispose();
  });
});
