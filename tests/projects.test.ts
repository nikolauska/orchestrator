import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkerStore } from "../src/runtime/store";
import { readProjects } from "../src/tools/projects";
import {
  cleanup,
  FakeExec,
  fixtureRoot,
  machineFixture,
  register,
  runtime,
  executionTargetFixture,
} from "./test-helpers";

afterEach(cleanup);
describe("project registry", () => {
  test("registers canonical identities, rejects aliases, and unregisters without deleting", async () => {
    const { root, project } = await fixtureRoot();
    const second = join(root, "second");
    await mkdir(second);
    const instance = runtime(root, new FakeExec(project), []);
    expect((await instance.runProjects({ op: "list" })).details).toEqual([]);
    await register(instance, second, "zeta");
    await register(instance, project, "alpha");
    await register(instance, project, "alpha");
    const registry = await readProjects(root);
    expect(Object.keys(registry.projects)).toEqual(["alpha", "zeta"]);
    expect(registry.projects.alpha).toMatchObject({
      machine: "local",
      path: project,
      pathKey: expect.any(String),
    });
    const alias = join(root, "alias");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    expect(
      (await instance.runProjects({ op: "add", name: "duplicate", path: alias })).isError,
    ).toBe(true);
    await instance.runProjects({ op: "remove", name: "zeta" });
    expect(Object.keys((await readProjects(root)).projects)).toEqual(["alpha"]);
    expect((await stat(second)).isDirectory()).toBe(true);
  });

  test.each(["add", "create"] as const)(
    "refuses reserved namespace %s without mutations",
    async (op) => {
      const { root, project } = await fixtureRoot();
      const fake = new FakeExec(project);
      const instance = runtime(root, fake, []);
      const raw = JSON.stringify({ retained: project });
      await writeFile(join(root, ".omp", "projects.json"), raw);
      const destination = op === "add" ? project : join(root, "reserved-destination");
      const result = await instance.runProjects({ op, name: "_independent", path: destination });
      expect(result.isError).toBe(true);
      expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(raw);
      expect(fake.calls).toEqual([]);
      if (op === "create") expect(await stat(destination).catch(() => undefined)).toBeUndefined();
    },
  );

  test("removes a legacy reserved registration without deleting its repository", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    await writeFile(join(root, ".omp", "projects.json"), JSON.stringify({ _independent: project }));
    const result = await instance.runProjects({ op: "remove", name: "_independent" });
    expect(result.isError).toBeUndefined();
    expect((await readProjects(root)).projects).toEqual({});
    expect((await stat(project)).isDirectory()).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  test("listing legacy data is offline; the first mutation preserves unavailable registrations and root", async () => {
    const { root, project } = await fixtureRoot();
    await mkdir(join(root, ".omp"));
    const raw = JSON.stringify({
      version: "Z:\\Offline\\version",
      unavailable: "/offline/repo",
      available: project,
    });
    const legacyRoot = "Z:\\Offline Projects";
    await writeFile(join(root, ".omp", "projects.json"), raw);
    await writeFile(join(root, ".omp", "projects-root"), legacyRoot);
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    const listed = await instance.runProjects({ op: "list" });
    expect(listed.details).toEqual(
      expect.arrayContaining([
        {
          name: "version",
          machine: "local",
          path: "Z:\\Offline\\version",
          issues: ["Pending local validation; path identity is unknown"],
        },
      ]),
    );
    expect(fake.calls).toEqual([]);
    expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(raw);
    expect(await readFile(join(root, ".omp", "projects-root"), "utf8")).toBe(legacyRoot);
    await register(instance, project, "available");
    const registry = await readProjects(root);
    expect(registry.projects.version).toEqual({ machine: "local", path: "Z:\\Offline\\version" });
    expect(registry.projects.unavailable).toEqual({ machine: "local", path: "/offline/repo" });
    expect(registry.projects.available!.pathKey).toEqual(expect.any(String));
    expect(registry.roots.local).toEqual({ path: legacyRoot });
    expect(await stat(join(root, ".omp", "projects-root")).catch(() => undefined)).toBeUndefined();
  });

  test("nonowner mutations cannot migrate or rewrite", async () => {
    const { root, project } = await fixtureRoot();
    const owner = runtime(root, new FakeExec(project), []);
    await register(owner, project);
    const before = await readFile(join(root, ".omp", "projects.json"), "utf8");
    const reader = runtime(root, new FakeExec(project), []);
    expect((await reader.runProjects({ op: "list" })).isError).toBeUndefined();
    expect((await reader.runProjects({ op: "remove", name: "fixture" })).isError).toBe(true);
    expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(before);
    owner.dispose();
    reader.dispose();
  });

  test("an interrupted writer's stale directory lock does not block registration", async () => {
    const { root, project } = await fixtureRoot();
    const instance = runtime(root, new FakeExec(project), []);
    const lock = join(root, ".omp", "projects.lock");
    const writer = Bun.spawn([
      process.execPath,
      "-e",
      `require("node:fs").mkdirSync(${JSON.stringify(lock)})`,
    ]);
    expect(await writer.exited).toBe(0);
    expect((await stat(lock)).isDirectory()).toBe(true);

    await register(instance, project);

    expect((await readProjects(root)).projects.fixture).toMatchObject({
      machine: "local",
      path: project,
      pathKey: expect.any(String),
    });
  });

  test.each(["list", "add", "create", "set-root"] as const)(
    "rejects an empty machine selector for %s without host calls or registry writes",
    async (op) => {
      const { root, project } = await fixtureRoot();
      const fake = new FakeExec(project);
      const instance = runtime(root, fake, []);
      const raw = JSON.stringify({ retained: project });
      await writeFile(join(root, ".omp", "projects.json"), raw);
      const params =
        op === "list"
          ? { op, machine: "" }
          : op === "set-root"
            ? { op, machine: "", path: project }
            : { op, machine: "", name: "app", path: join(root, "destination") };

      expect((await instance.runProjects(params)).isError).toBe(true);
      expect(fake.calls).toEqual([]);
      expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(raw);
      expect(await stat(join(root, "destination")).catch(() => undefined)).toBeUndefined();
    },
  );

  test("concurrent mutations preserve both registrations", async () => {
    const { root, project } = await fixtureRoot();
    const second = join(root, "second");
    await mkdir(second);
    const instance = runtime(root, new FakeExec(project), []);
    const results = await Promise.all([
      instance.runProjects({ op: "add", name: "one", path: project }),
      instance.runProjects({ op: "add", name: "two", path: second }),
    ]);
    expect(results.map((result) => result.isError)).toEqual([undefined, undefined]);
    expect(Object.keys((await readProjects(root)).projects)).toEqual(["one", "two"]);
  });

  test("malformed and unknown-version registries fail without rewriting", async () => {
    const { root, project } = await fixtureRoot();
    await mkdir(join(root, ".omp"));
    const instance = runtime(root, new FakeExec(project), []);
    for (const raw of [
      "{bad",
      '{"version":9,"projects":{}}',
      '{"version":2,"projects":{"app":"/mixed"}}',
    ]) {
      await writeFile(join(root, ".omp", "projects.json"), raw);
      expect((await instance.runProjects({ op: "list" })).isError).toBe(true);
      expect((await instance.runProjects({ op: "add", name: "app", path: project })).isError).toBe(
        true,
      );
      expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(raw);
    }
  });

  test("creates local initial commits under a configured root and refuses existing destinations", async () => {
    const { root, project } = await fixtureRoot();
    const projectsRoot = join(root, "Nïko Projects");
    await mkdir(projectsRoot);
    const fake = new FakeExec(project);
    const instance = runtime(root, fake, []);
    expect((await instance.runProjects({ op: "create", name: "api" })).isError).toBe(true);
    expect(
      (await instance.runProjects({ op: "set-root", path: projectsRoot })).details,
    ).toMatchObject({ machine: "local", path: projectsRoot, path_key: expect.any(String) });
    expect((await instance.runProjects({ op: "create", name: "api" })).isError).toBeUndefined();
    const registry = await readProjects(root);
    expect(registry.projects.api).toMatchObject({
      machine: "local",
      path: join(projectsRoot, "api"),
      pathKey: expect.any(String),
    });
    expect(fake.createdProjects.has(join(projectsRoot, "api"))).toBe(true);
    expect(
      (await instance.runProjects({ op: "create", name: "existing", path: project })).isError,
    ).toBe(true);
    expect((await readProjects(root)).projects.existing).toBeUndefined();
  });

  for (const failure of ["gitInitFails", "gitCommitFails"] as const)
    test(`retains and identifies partial local creation when ${failure}`, async () => {
      const { root, project } = await fixtureRoot();
      const destination = join(root, "failed");
      const fake = new FakeExec(project);
      fake[failure] = true;
      const instance = runtime(root, fake, []);
      const result = await instance.runProjects({
        op: "create",
        name: "failed",
        path: destination,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining(destination) }),
        ]),
      );
      expect((await stat(destination)).isDirectory()).toBe(true);
      expect((await readProjects(root)).projects.failed).toBeUndefined();
    });

  test("validates remote roots on their host and refuses duplicate host aliases", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, hosts } = await machineFixture(root, project);
    for (const machine of ["workbox", "mac"])
      expect(
        (
          await instance.runProjects({
            op: "add",
            name: machine,
            machine,
            path: "/srv/projects/repo",
          })
        ).isError,
      ).toBeUndefined();
    expect(
      (
        await instance.runProjects({
          op: "add",
          name: "alias",
          machine: "alias",
          path: "/srv/projects/repo",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await instance.runProjects({
          op: "add",
          name: "nested",
          machine: "workbox",
          path: "/srv/projects/repo/src",
        })
      ).isError,
    ).toBe(true);
    const registry = await readProjects(root);
    expect(registry.projects.workbox!.binding!.hostId).toBe(hosts.get("workbox-ssh")!.hostId);
    expect(registry.projects.mac!.binding!.hostId).not.toBe(
      registry.projects.workbox!.binding!.hostId,
    );
    expect((await instance.runProjects({ op: "list" })).details).toEqual([]);
  });

  test("reusing a remote project name on another machine refuses the name before binding validation", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, helperCalls } = await machineFixture(root, project);
    expect(
      (
        await instance.runProjects({
          op: "add",
          name: "app",
          machine: "workbox",
          path: "/srv/projects/repo",
        })
      ).isError,
    ).toBeUndefined();
    const before = await readFile(join(root, ".omp", "projects.json"), "utf8");
    helperCalls.length = 0;

    const result = await instance.runProjects({
      op: "add",
      name: "app",
      machine: "mac",
      path: "/srv/projects/repo",
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      error: { channel: "controller", effect: "none" },
    });
    expect(result.details).not.toMatchObject({ error: { code: "PROFILE_CHANGED" } });
    expect(helperCalls.some((call) => call.op === "path.validate")).toBe(false);
    expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(before);
  });

  test("creates on Windows using host-native roots and leaves partial remote repos in place", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, hosts } = await machineFixture(root, project);
    const host = hosts.get("windows-ssh")!;
    expect(
      (await instance.runProjects({ op: "set-root", machine: "windows", path: host.root })).isError,
    ).toBeUndefined();
    expect(
      (await instance.runProjects({ op: "create", name: "api", machine: "windows" })).isError,
    ).toBeUndefined();
    const path = `${host.root}\\api`;
    expect(host.files.get(path)).toMatchObject({ git: true, head: "b".repeat(40) });
    expect((await readProjects(root)).projects.api!.path).toBe(path);
    host.failCreate = true;
    const failed = await instance.runProjects({ op: "create", name: "failed", machine: "windows" });
    expect(failed.isError).toBe(true);
    expect(failed.details).toMatchObject({ machine: "windows", path: `${host.root}\\failed` });
    expect(host.files.get(`${host.root}\\failed`)).toMatchObject({ git: false });
    expect((await readProjects(root)).projects.failed).toBeUndefined();
  });

  test("offline list/remove preserve workers; disabled and changed bindings refuse host mutations", async () => {
    const { root, project } = await fixtureRoot();
    const { instance, hosts, profiles, helperCalls } = await machineFixture(root, project);
    await instance.runProjects({
      op: "add",
      name: "app",
      machine: "workbox",
      path: "/srv/projects/repo",
    });
    const store = new WorkerStore(join(root, ".omp", "orchestrator.db"));
    store.save({
      name: "retained",
      scope: "independent",
      kind: "scout",
      status: "starting",
      phase: "preflighted",
      generation: 0,
      target: executionTargetFixture("linux", "workbox"),
      agent_name: "o12345678-12345678123441238123",
    });
    const worker = store.all();
    const profile = profiles[0]!;
    profile.enabled = false;
    expect(
      (
        await instance.runProjects({
          op: "add",
          name: "other",
          machine: "workbox",
          path: "/srv/projects/repo",
        })
      ).isError,
    ).toBe(true);
    profile.enabled = true;
    profile.session = "changed";
    expect(
      (
        await instance.runProjects({
          op: "add",
          name: "app",
          machine: "workbox",
          path: "/srv/projects/repo",
        })
      ).isError,
    ).toBe(true);
    profile.session = "agents";
    hosts.get("workbox-ssh")!.offline = true;
    helperCalls.length = 0;
    expect((await instance.runProjects({ op: "list", machine: "workbox" })).details).toEqual([
      expect.objectContaining({ name: "app", machine: "workbox" }),
    ]);
    expect((await instance.runProjects({ op: "remove", name: "app" })).isError).toBeUndefined();
    expect(helperCalls).toEqual([]);
    expect(store.all()).toEqual(worker);
    store.close();
  });
});
