import { describe, expect, test } from "bun:test";
import { executionTargetFixture } from "./test-helpers";
import { targetKey, type ExecutionTarget } from "../src/runtime/execution";
import { hostErrorSchema } from "../src/runtime/helper-protocol";
import {
  closeWorkerSpace,
  createTab,
  createWorkspace,
  ensureIntegration,
  getAgent,
  agentBinding,
  HerdrError,
  interruptAgent,
  listWorkspaces,
  promptAgent,
  readAgent,
  startOmpAgent,
  waitForAgent,
  waitForShell,
  type HerdrIntegrationEvidence,
} from "../src/runtime/herdr";
import { projectSpace, researchSpace, serializeSpaces } from "../src/runtime/spaces";
import type { ExecResult, RuntimeDeps } from "../src/runtime/shared";

type Pane = {
  name: string;
  agent: string;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  cwd: string;
  agent_status: string;
  screen: string;
  agent_session: { kind: string; value: string };
  completion_seq: number;
  state_change_seq: number;
};
type Workspace = {
  workspace_id: string;
  label: string;
  cwd: string;
  worktree?: { repo_root: string; is_linked_worktree: boolean; checkout_path: string };
};
class Server {
  readonly panes = new Map<string, Pane>();
  readonly workspaces = new Map<string, Workspace>();
  readonly overlays = new Map<string, string>();
  readonly profiles = new Map<string, string>();
  readonly submissions: string[] = [];
  enterCount = 0;
  mutations = 0;
  version = "0.9.3";
  protocol = 22;
  compatible = true;
  generation = 1;
  integrationVersion = 10;
  promptError?: "stalled" | "transport" | "timeout" | "replace";
  loseCreateReply = false;
  loseEnterReply = false;
  stalledStatus?: string;
  recoveryFailure?: "recheck" | "enter" | "wait" | "wait-timeout";
  constructor(readonly target: ExecutionTarget) {
    this.overlays.set(target.workerConfig.path, "unattended");
    if (target.ompProfile) this.profiles.set(target.ompProfile, "host-auth");
  }
  addPane(pane = "w1:p1", name = "worker", cwd = this.target.neutralRoot.path): Pane {
    const value: Pane = {
      name,
      agent: "omp",
      pane_id: pane,
      tab_id: "w1:t1",
      workspace_id: "w1",
      terminal_id: "terminal-1",
      cwd,
      agent_status: "idle",
      screen: "Ready",
      agent_session: { kind: "path", value: `${cwd}/session.jsonl` },
      completion_seq: 2,
      state_change_seq: 4,
    };
    this.panes.set(pane, value);
    return value;
  }
}
class FakeHerdr {
  readonly servers = new Map<string, Server>();
  inherited?: Server;
  add(target: ExecutionTarget): Server {
    const server = new Server(target);
    this.servers.set(targetKey(target), server);
    if (target.kind === "local" && !this.inherited) this.inherited = server;
    return server;
  }
  deps: RuntimeDeps = {
    logger: {} as RuntimeDeps["logger"],
    notify: () => {},
    exec: (async (binary, input) => {
      if (binary !== "herdr") throw new Error("Unexpected executable");
      let server = this.inherited;
      let args = input;
      if (input[0] === "--machine") {
        server = [...this.servers.values()].find(
          (value) => value.target.kind === "ssh" && value.target.machineId === input[1],
        );
        args = input.slice(2);
      } else if (input[0] === "--session") {
        server = [...this.servers.values()].find(
          (value) => value.target.kind === "local" && value.target.session === input[1],
        );
        args = input.slice(2);
      }
      if (!server) throw new Error("SSH secret diagnostics agent_prompt_stalled");
      return this.run(server, args);
    }) as RuntimeDeps["exec"],
  };
  async run(server: Server, args: string[]): Promise<ExecResult> {
    const ok = (result: unknown): ExecResult => ({
      stdout: JSON.stringify({ result }),
      stderr: "",
      code: 0,
    });
    const fail = (code: string): ExecResult => ({
      stdout: "",
      stderr: JSON.stringify({ error: { code, message: "private input must not escape" } }),
      code: 1,
    });
    const [group, action] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    if (group === "status")
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          running: true,
          session: server.target.session === "default" ? null : server.target.session,
          version: server.version,
          protocol: server.protocol,
          compatible: server.compatible,
          endpoint_compatible: server.compatible,
          capabilities: { endpoint_protocol_generation: server.generation, health_check: true },
        }),
      };
    if (group === "integration")
      return {
        code: 0,
        stderr: "",
        stdout: `omp: current (v${server.integrationVersion}) (host-native file)`,
      };
    if (group === "api")
      return ok({
        snapshot: {
          agents: [...server.panes.values()],
          workspaces: [...server.workspaces.values()],
        },
      });
    if (group === "workspace" && action === "list")
      return ok({ workspaces: [...server.workspaces.values()] });
    if (group === "workspace" && action === "rename") {
      const workspace = server.workspaces.get(args[2]!);
      if (!workspace) return fail("workspace_not_found");
      server.mutations++;
      workspace.label = args[3]!;
      return ok({});
    }
    if (group === "workspace" && action === "close") {
      if (!server.workspaces.delete(args[2]!)) return fail("workspace_not_found");
      server.mutations++;
      for (const [id, pane] of server.panes)
        if (pane.workspace_id === args[2]) server.panes.delete(id);
      return ok({});
    }
    if (group === "tab" && action === "close") {
      const pane = [...server.panes.values()].find((p) => p.tab_id === args[2]);
      if (!pane) return fail("tab_not_found");
      server.panes.delete(pane.pane_id);
      server.mutations++;
      return ok({});
    }
    if (
      ((group === "workspace" || group === "tab") && action === "create") ||
      (group === "worktree" && action === "open")
    ) {
      if (group === "worktree") {
        const path = flag("--path");
        if ([...server.workspaces.values()].some((w) => w.worktree?.checkout_path === path))
          return ok({ already_open: true });
        if (
          ![...server.workspaces.values()].some(
            (w) => w.worktree?.repo_root === flag("--cwd") && !w.worktree.is_linked_worktree,
          )
        )
          server.workspaces.set("parent", {
            workspace_id: "parent",
            label: "folder",
            cwd: flag("--cwd"),
            worktree: {
              repo_root: flag("--cwd"),
              checkout_path: flag("--cwd"),
              is_linked_worktree: false,
            },
          });
      }
      const id = group === "tab" ? flag("--workspace") : `w${server.workspaces.size + 1}`;
      const pane = server.addPane(
        `${id}:p${server.panes.size + 1}`,
        "",
        group === "worktree" ? flag("--path") : flag("--cwd"),
      );
      pane.workspace_id = id;
      pane.tab_id = `${id}:t${server.panes.size}`;
      pane.agent = "";
      pane.screen = server.target.os === "win32" ? "PS C:\\Users\\日本語 ❯" : "custom ❯";
      if (group !== "tab")
        server.workspaces.set(id, {
          workspace_id: id,
          label: flag("--label"),
          cwd: pane.cwd,
          ...(group === "worktree"
            ? {
                worktree: {
                  repo_root: flag("--cwd"),
                  checkout_path: pane.cwd,
                  is_linked_worktree: true,
                },
              }
            : {}),
        });
      server.mutations++;
      if (server.loseCreateReply) throw new Error("connection lost after creation");
      return ok({
        workspace: { workspace_id: id },
        tab: { tab_id: pane.tab_id },
        root_pane: { pane_id: pane.pane_id },
      });
    }
    if (group === "pane" && action === "wait-output") {
      const pane = server.panes.get(args[2]!);
      if (!pane) return fail("pane_not_found");
      return new RegExp(flag("--regex")).test(pane.screen) ? ok({}) : fail("timeout");
    }
    if (group === "agent" && action === "start") {
      const pane = server.panes.get(flag("--pane"));
      if (!pane || pane.agent) return fail("agent_mismatch");
      const config = args.find((arg) => arg.startsWith("--config="))?.slice(9);
      if (
        !config ||
        !server.overlays.has(config) ||
        (args.includes("--profile") && !server.profiles.has(flag("--profile")))
      )
        return fail("invalid_params");
      pane.name = args[2]!;
      pane.agent = "omp";
      pane.cwd = flag("--cwd");
      pane.screen = `${server.overlays.get(config)} ${args.includes("--profile") ? server.profiles.get(flag("--profile")) : "default-profile"} ${flag("--model")} ${args.includes("--thinking") ? flag("--thinking") : "off"}`;
      server.mutations++;
      return ok({ agent: pane });
    }
    if (group === "agent") {
      const pane = server.panes.get(args[2]!);
      if (!pane) return fail("agent_not_found");
      if (action === "get") {
        if (server.recoveryFailure === "recheck" && server.submissions.length)
          throw new Error("Recheck connection lost");
        return ok({ agent: pane });
      }
      if (action === "read") return { code: 0, stderr: "", stdout: pane.screen };
      if (action === "wait") {
        if (server.recoveryFailure === "wait") throw new Error("Wait connection lost");
        return server.recoveryFailure === "wait-timeout" ? fail("timeout") : ok({ agent: pane });
      }
      if (action === "send-keys") {
        if (server.recoveryFailure === "enter") return fail("agent_not_found");
        server.mutations++;
        if (args[3] === "enter") {
          server.enterCount++;
          pane.agent_status = "working";
        } else pane.agent_status = "idle";
        if (server.loseEnterReply && args[3] === "enter")
          throw new Error("Enter applied, acknowledgement lost");
        return ok({});
      }
      if (action === "prompt") {
        server.submissions.push(args[3]!);
        server.mutations++;
        if (server.promptError === "transport")
          throw new Error("SSH agent_prompt_stalled private text");
        if (server.promptError === "timeout") return fail("timeout");
        if (server.promptError === "replace") pane.terminal_id = "foreign-terminal";
        if (server.stalledStatus) pane.agent_status = server.stalledStatus;
        if (server.promptError) return fail("agent_prompt_stalled");
        pane.agent_status = "working";
        return ok({});
      }
    }
    throw new Error("Unexpected command");
  }
}
function evidence(target: ExecutionTarget): HerdrIntegrationEvidence {
  return {
    targetKey: targetKey(target),
    check: { name: "herdr-omp-integration", available: true, version: "10", capabilities: [] },
  };
}

describe("target-bound Herdr", () => {
  test("colliding IDs read, prompt, wait, interrupt and close only the bound machine", async () => {
    const fake = new FakeHerdr();
    const local = executionTargetFixture();
    const remote = executionTargetFixture("win32", "windows");
    const a = fake.add(local);
    const b = fake.add(remote);
    a.addPane().screen = "local";
    b.addPane().screen = "remote";
    a.workspaces.set("w1", { workspace_id: "w1", label: "local", cwd: "/local" });
    b.workspaces.set("w1", { workspace_id: "w1", label: "remote", cwd: "C:\\remote" });
    expect(await readAgent(fake.deps, remote, "w1:p1", 40)).toBe("remote");
    await promptAgent(fake.deps, remote, "w1:p1", "work");
    await waitForAgent(fake.deps, remote, "w1:p1");
    expect((await getAgent(fake.deps, remote, "w1:p1")).status).toBe("working");
    expect((await getAgent(fake.deps, local, "w1:p1")).status).toBe("idle");
    await interruptAgent(fake.deps, remote, "w1:p1");
    await closeWorkerSpace(fake.deps, remote, { scope: "project", workspace_id: "w1" });
    expect(a.panes.get("w1:p1")?.screen).toBe("local");
    expect(b.panes.has("w1:p1")).toBe(false);
    expect(a.submissions).toEqual([]);
    expect(b.submissions).toEqual(["work"]);
  });
  test("retained local targets ignore a changed inherited session", async () => {
    const fake = new FakeHerdr();
    const bound = executionTargetFixture();
    const other = { ...bound, session: "other" };
    const a = fake.add(bound);
    const b = fake.add(other);
    a.addPane().screen = "bound";
    b.addPane().screen = "other";
    fake.inherited = b;
    expect(await readAgent(fake.deps, bound, "w1:p1", 40)).toBe("bound");
    expect(a.submissions).toEqual([]);
    expect(b.submissions).toEqual([]);
  });
  test("preflight inspects the live server and rejects missing or wrong-host integration evidence", async () => {
    const fake = new FakeHerdr();
    const local = executionTargetFixture();
    const remote = executionTargetFixture("darwin", "mac");
    const a = fake.add(local);
    const b = fake.add(remote);
    expect(await ensureIntegration(fake.deps, local)).toMatchObject({
      version: "0.9.3",
      session: "agents",
    });
    await expect(ensureIntegration(fake.deps, remote)).rejects.toMatchObject({
      code: "PREREQUISITE_MISSING",
    });
    await expect(
      ensureIntegration(fake.deps, remote, { integration: evidence(local) }),
    ).rejects.toMatchObject({ code: "PREREQUISITE_MISSING" });
    expect(
      await ensureIntegration(fake.deps, remote, { integration: evidence(remote) }),
    ).toMatchObject({ protocol: 22 });
    b.protocol = 21;
    await expect(
      ensureIntegration(fake.deps, remote, { integration: evidence(remote) }),
    ).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
    a.integrationVersion = 2;
    await expect(ensureIntegration(fake.deps, local)).rejects.toMatchObject({
      code: "PREREQUISITE_MISSING",
    });
    a.compatible = false;
    await expect(ensureIntegration(fake.deps, local)).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
    expect(a.mutations + b.mutations).toBe(0);
  });
  test.each(["linux", "darwin", "win32"] as const)(
    "host configuration and exact model start under a custom %s prompt",
    async (os) => {
      const fake = new FakeHerdr();
      const target = { ...executionTargetFixture(os, `host-${os}`), ompProfile: "worker profile" };
      const server = fake.add(target);
      const directory =
        os === "win32"
          ? "D:\\Project & Data\\日本語 ! %\\checkout"
          : "/host/Project & Data/日本語 ! %/checkout";
      const space = await createWorkspace(fake.deps, target, directory, "worker");
      await waitForShell(fake.deps, target, space.paneId);
      await startOmpAgent(fake.deps, target, "worker", space.paneId, directory, {
        model: "openai/gpt-6.1-sol",
        thinking: "high",
      });
      expect(await readAgent(fake.deps, target, space.paneId, 40)).toBe(
        "unattended host-auth openai/gpt-6.1-sol high",
      );
      expect((await getAgent(fake.deps, target, space.paneId)).cwd).toBe(directory);
      expect(server.panes.get(space.paneId)?.agent).toBe("omp");
    },
  );
  test.each(["stalled", "transport", "timeout", "replace"] as const)(
    "prompt recovery handles %s without replay",
    async (failure) => {
      const fake = new FakeHerdr();
      const target = executionTargetFixture("win32", "remote");
      const server = fake.add(target);
      server.addPane();
      server.promptError = failure;
      if (failure === "stalled")
        await promptAgent(fake.deps, target, "w1:p1", "private assignment");
      else
        await expect(
          promptAgent(fake.deps, target, "w1:p1", "private assignment"),
        ).rejects.toBeInstanceOf(HerdrError);
      expect(server.submissions).toEqual(["private assignment"]);
      expect(server.enterCount).toBe(failure === "stalled" ? 1 : 0);
    },
  );
  test("lost Enter acknowledgement cannot trigger a second recovery input", async () => {
    const fake = new FakeHerdr();
    const target = executionTargetFixture("win32", "remote");
    const server = fake.add(target);
    server.addPane();
    server.promptError = "stalled";
    server.loseEnterReply = true;
    const error = await promptAgent(fake.deps, target, "w1:p1", "private assignment").catch(
      (error) => error,
    );
    const stored = hostErrorSchema.parse(JSON.parse(JSON.stringify(error)));
    expect(stored).toMatchObject({ channel: "herdr", effect: "unknown", retry: "reconcile" });
    expect(stored.message).not.toContain("private assignment");
    expect(server.submissions).toEqual(["private assignment"]);
    expect(server.enterCount).toBe(1);
  });
  test.each(["recheck", "enter", "wait", "wait-timeout"] as const)(
    "stalled prompt %s failure remains uncertain without replay",
    async (failure) => {
      const fake = new FakeHerdr();
      const target = executionTargetFixture("win32", "remote");
      const server = fake.add(target);
      server.addPane();
      server.promptError = "stalled";
      server.recoveryFailure = failure;
      await expect(
        promptAgent(fake.deps, target, "w1:p1", "private assignment"),
      ).rejects.toMatchObject({
        code:
          failure === "wait-timeout"
            ? "OPERATION_UNCERTAIN"
            : failure === "enter"
              ? "RESOURCE_NOT_FOUND"
              : "TRANSPORT_OFFLINE",
        effect: "unknown",
        retry: "reconcile",
      });
      expect(server.submissions).toEqual(["private assignment"]);
      expect(server.enterCount).toBe(failure.startsWith("wait") ? 1 : 0);
    },
  );
  test.each(["working", "blocked"])(
    "late %s activity after a structured stall receives no Enter",
    async (status) => {
      const fake = new FakeHerdr();
      const target = executionTargetFixture("linux", "remote");
      const server = fake.add(target);
      server.addPane();
      server.promptError = "stalled";
      server.stalledStatus = status;
      await promptAgent(fake.deps, target, "w1:p1", "assignment");
      expect(server.panes.get("w1:p1")?.agent_status).toBe(status);
      expect(server.enterCount).toBe(0);
      expect(server.submissions).toEqual(["assignment"]);
    },
  );
  test("binding rejects a foreign cwd and preserves observed completion and incarnation evidence", async () => {
    const fake = new FakeHerdr();
    const target = executionTargetFixture("win32", "remote");
    fake.add(target).addPane();
    const agent = await getAgent(fake.deps, target, "w1:p1");
    const expected = { name: "worker", paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" };
    expect(() =>
      agentBinding(target, agent, { path: "C:\\foreign", pathKey: "foreign" }, expected, 1),
    ).toThrow(HerdrError);
    expect(agentBinding(target, agent, target.neutralRoot, expected, 1)).toMatchObject({
      session: "agents",
      incarnation: "terminal-1",
      completionSeq: 2,
      cwd: target.neutralRoot,
    });
  });
  test("lost creation replies retain the applied effect and never create again automatically", async () => {
    const fake = new FakeHerdr();
    const target = executionTargetFixture("linux", "remote");
    const server = fake.add(target);
    server.loseCreateReply = true;
    await expect(
      createWorkspace(fake.deps, target, "/remote/neutral", "worker"),
    ).rejects.toMatchObject({
      channel: "herdr",
      code: "TRANSPORT_OFFLINE",
      effect: "unknown",
      retry: "reconcile",
    });
    expect([...server.workspaces.values()].map((space) => space.label)).toEqual(["worker"]);
    await expect(
      closeWorkerSpace(fake.deps, target, { scope: "project", workspace_id: "foreign" }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", effect: "none" });
    expect(server.workspaces.size).toBe(1);
  });
  test("research spaces are separate across targets and an independent close keeps the shared space", async () => {
    const fake = new FakeHerdr();
    const state = { deps: fake.deps };
    const a = executionTargetFixture();
    const b = executionTargetFixture("win32", "remote");
    const local = fake.add(a);
    const remote = fake.add(b);
    local.workspaces.set("w-local", {
      workspace_id: "w-local",
      label: "research",
      cwd: a.neutralRoot.path,
    });
    const [localId, remoteId, again] = await Promise.all([
      researchSpace(state, a),
      researchSpace(state, b),
      researchSpace(state, b),
    ]);
    expect(localId).toBe("w-local");
    expect(remoteId).toBe(again);
    expect(remoteId).not.toBe(localId);
    expect([...remote.workspaces.values()].map((space) => space.label)).toEqual(["research"]);
    const tab = await createTab(fake.deps, b, remoteId, "D:\\neutral\\scout", "scout·one");
    await closeWorkerSpace(fake.deps, b, { scope: "independent", tab_id: tab.tabId });
    expect(remote.workspaces.get(remoteId)?.cwd).toBe(b.neutralRoot.path);
  });
  test("queues serialize matching targets without blocking a different machine", async () => {
    const fake = new FakeHerdr();
    const state = { deps: fake.deps };
    const a = executionTargetFixture();
    const b = executionTargetFixture("win32", "remote");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const first = serializeSpaces(state, a, async () => {
      events.push("a-start");
      await gate;
      events.push("a-end");
    });
    const second = serializeSpaces(state, a, async () => {
      events.push("a-second");
    });
    await serializeSpaces(state, b, async () => {
      events.push("b");
    });
    expect(events).toEqual(["a-start", "b"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["a-start", "b", "a-end", "a-second"]);
  });
  test("existing project labels survive while newly created parents use the registration name", async () => {
    const fake = new FakeHerdr();
    const target = executionTargetFixture("win32", "remote");
    const server = fake.add(target);
    const state = { deps: fake.deps };
    const root = "C:\\src\\Project";
    server.workspaces.set("mine", {
      workspace_id: "mine",
      label: "My project",
      cwd: root,
      worktree: { repo_root: root, checkout_path: root, is_linked_worktree: false },
    });
    const worker = await projectSpace(
      state,
      target,
      "registered",
      root,
      "D:\\treehouse\\one",
      "impl·one",
    );
    expect((await listWorkspaces(fake.deps, target)).map((space) => space.label)).toEqual([
      "My project",
      "impl·one",
    ]);
    const second = await projectSpace(
      state,
      target,
      "new-registration",
      "C:\\src\\Second",
      "D:\\treehouse\\two",
      "scout·two",
    );
    expect(server.workspaces.get("parent")?.label).toBe("new-registration");
    await closeWorkerSpace(fake.deps, target, {
      scope: "project",
      workspace_id: worker.workspaceId,
    });
    expect(server.workspaces.get("mine")?.label).toBe("My project");
    expect(server.workspaces.get(second.workspaceId)?.label).toBe("scout·two");
  });
});
