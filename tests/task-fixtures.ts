import { zod as z } from "@oh-my-pi/pi-coding-agent";
import type { CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostRuntime,
  dispatchHostRequest,
  nativeExec,
  type HostRuntime,
} from "../.omp/runtime/host";
import { validateHostRequest } from "../.omp/runtime/helper-protocol";
import { canonicalPath } from "../.omp/runtime/host-paths";
import { WORKER_CONFIG } from "../.omp/runtime/herdr";
import type { ExecResult, ToolAPI } from "../.omp/runtime/shared";
import taskTool from "../.omp/extensions/orchestrator/orchestrator_task";
import { disposeWorkers, stateFor } from "../.omp/extensions/orchestrator/workers";

type Pane = {
  cwd: string;
  workspace: string;
  tab: string;
  alias?: string;
  model?: string;
  thinking?: string;
  status: string;
  prompts: number;
  completionSeq?: number;
  sessionPath?: string;
};
type FixtureHostState = {
  allocated: number;
  returned: number;
  modelMismatch: boolean;
  missing: boolean;
  lost: string;
  refusedAllocations: number;
  futureSessionPath?: string;
  idleAfterPrompt?: boolean;
  beforeSnapshot?: () => Promise<void>;
  panes: Map<string, Pane>;
  workspaces: Map<string, { label: string; cwd: string; checkout?: string }>;
  leases: Array<{ path: string; lease_id: string; lease_holder: string }>;
  mutations: Map<string, number>;
};
type FixtureHost = {
  root: string;
  project: string;
  runtime: HostRuntime;
  hostId: string;
  state: FixtureHostState;
  sourceHead: string;
  researchHead: string;
};
export async function launchFixture() {
  const base = await mkdtemp(join(tmpdir(), "launch-hosts-"));
  const controller = join(base, "controller");
  await mkdir(controller);
  const git = async (cwd: string, args: string[]) => {
    const result = await nativeExec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd },
    );
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const hosts = new Map<string, FixtureHost>();
  const ok = (value: unknown): ExecResult => ({
    code: 0,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: "",
  });
  async function makeHost(id: string) {
    const root = join(base, id);
    const project = join(root, "projects", "repo");
    const runtimeRoot = join(root, "runtime");
    const neutralRoot = join(root, "neutral");
    await Promise.all(
      [project, runtimeRoot, neutralRoot].map((path) => mkdir(path, { recursive: true })),
    );
    await git(project, ["init", "--initial-branch=main"]);
    await writeFile(join(project, "source.txt"), `${id} main\n`);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "main"]);
    const sourceHead = await git(project, ["rev-parse", "HEAD"]);
    await git(project, ["switch", "-c", "research"]);
    await writeFile(join(project, "source.txt"), `${id} research\n`);
    await git(project, ["commit", "-am", "research"]);
    const researchHead = await git(project, ["rev-parse", "HEAD"]);
    await git(project, ["switch", "main"]);
    const state = {
      allocated: 0,
      returned: 0,
      modelMismatch: false,
      missing: false,
      lost: "",
      refusedAllocations: 0,
      panes: new Map<string, Pane>(),
      workspaces: new Map<string, { label: string; cwd: string; checkout?: string }>(),
      leases: [] as Array<{ path: string; lease_id: string; lease_holder: string }>,
      mutations: new Map<string, number>(),
    };
    const hostId = randomUUID();
    const hostExec: ToolAPI["exec"] = async (command, args, options) => {
      if (args[0] === "omp-fixture") {
        if (state.missing) return { code: 1, killed: false, stdout: "", stderr: "OMP unavailable" };
        if (args.includes("models"))
          return {
            ...ok({
              models: [
                {
                  kind: "chat",
                  selector:
                    state.modelMismatch && options?.cwd !== project && options?.cwd !== root
                      ? "openai-codex/changed"
                      : `openai-codex/${id}`,
                  thinking: ["high"],
                  input: ["text"],
                },
              ],
            }),
            killed: false,
          };
        if (args.includes("modelRoles"))
          return { ...ok({ value: { default: `openai-codex/${id}:high` } }), killed: false };
        if (args.includes("path")) return { ...ok(join(root, "omp")), killed: false };
        return { ...ok("OMP 18.4.4"), killed: false };
      }
      if (args[0] === "treehouse-fixture") {
        const operation = args[1];
        if (args.includes("--help"))
          return { ...ok("--lease-holder --json --if-lease-id --if-lease-holder"), killed: false };
        if (operation === "status") return { ...ok(state.leases), killed: false };
        if (operation === "get") {
          const path = join(root, "leases", `slot-${++state.allocated}`);
          await git(project, ["worktree", "add", "--detach", path, "HEAD"]);
          const lease = {
            path,
            lease_id: randomUUID().replaceAll("-", ""),
            lease_holder: args[args.indexOf("--lease-holder") + 1]!,
          };
          state.leases.push(lease);
          return { ...ok(lease), killed: false };
        }
        if (operation === "return") {
          const index = state.leases.findIndex(
            (lease) =>
              lease.lease_id === args[args.indexOf("--if-lease-id") + 1] &&
              lease.lease_holder === args[args.indexOf("--if-lease-holder") + 1],
          );
          if (index < 0) throw new Error("Foreign lease");
          state.leases.splice(index, 1);
          state.returned++;
          return { ...ok("returned"), killed: false };
        }
        return { ...ok("Treehouse 1"), killed: false };
      }
      if (args[0] === "integration") return { ...ok("omp: current (v10)"), killed: false };
      const result = await nativeExec(command, args, options);
      return { ...result, killed: result.killed ?? false };
    };
    const runtime = createHostRuntime(
      {
        version: 1,
        hostId,
        overlayPath: WORKER_CONFIG,
        runtimeRoot,
        neutralRoot,
        queryCwd: root,
        approvedProjectRoots: [join(root, "projects")],
        executables: {
          git: { executable: Bun.which("git")!, prefixArgs: [] },
          treehouse: { executable: process.execPath, prefixArgs: ["treehouse-fixture"] },
          omp: { executable: process.execPath, prefixArgs: ["omp-fixture"] },
        },
      },
      { exec: hostExec, logger: {} as ToolAPI["logger"], sendMessage: () => {} },
      {
        local: id === "local",
        discoverExecutable: (name) => (name === "herdr" ? process.execPath : Bun.which(name)),
      },
    );
    return { root, project, runtime, hostId, state, sourceHead, researchHead };
  }
  for (const id of ["local", "remote"]) hosts.set(id, await makeHost(id));
  const controllerExec: ToolAPI["exec"] = async (_command, input) => {
    const id = input[0] === "--machine" ? input[1]! : "local";
    const args = input[0] === "--machine" || input[0] === "--session" ? input.slice(2) : input;
    const host = hosts.get(id)!;
    const state = host.state;
    const option = (key: string) => args[args.indexOf(key) + 1]!;
    const server = {
      running: true,
      compatible: true,
      endpoint_compatible: true,
      session: id === "local" ? null : "agents",
      version: "0.9.3",
      protocol: 22,
      capabilities: { endpoint_protocol_generation: 1, health_check: true },
    };
    let result: ExecResult;
    if (args[0] === "machine" && args[1] === "list")
      result = ok([
        { id: "remote", label: "Remote", target: "remote-ssh", session: "agents", enabled: true },
      ]);
    else if (args[0] === "machine" && args[1] === "status")
      result = ok([{ id: "remote", status: "reachable" }]);
    else if (args[0] === "status") result = ok(server);
    else if (args[0] === "integration") result = ok("omp: current (v10)");
    else if (args[0] === "api")
      result = ok({ result: { snapshot: { agents: [], workspaces: [] } } });
    else if (args[0] === "workspace" && args[1] === "list")
      result = ok({
        result: {
          workspaces: [...state.workspaces].map(([workspace_id, value]) => ({
            workspace_id,
            label: value.label,
            cwd: value.cwd,
            ...(value.checkout
              ? {
                  worktree: {
                    repo_root: host.project,
                    is_linked_worktree: true,
                    checkout_path: value.checkout,
                  },
                }
              : {}),
          })),
        },
      });
    else if (args[0] === "workspace" && args[1] === "create") {
      const workspace = `space-${state.workspaces.size}`;
      state.workspaces.set(workspace, { label: option("--label"), cwd: option("--cwd") });
      result = ok({
        result: {
          workspace: { workspace_id: workspace },
          tab: { tab_id: `${workspace}-tab` },
          root_pane: { pane_id: `${workspace}-pane` },
        },
      });
    } else if (args[0] === "workspace" && args[1] === "rename") {
      state.workspaces.get(args[2]!)!.label = args[3]!;
      result = ok({});
    } else if (args[0] === "workspace" && args[1] === "close") {
      state.workspaces.delete(args[2]!);
      for (const [id, pane] of state.panes) if (pane.workspace === args[2]) state.panes.delete(id);
      result = ok({});
    } else if (args[0] === "tab" && args[1] === "close") {
      for (const [id, pane] of state.panes) if (pane.tab === args[2]) state.panes.delete(id);
      result = ok({});
    } else if (args[0] === "worktree" && args[1] === "open") {
      const workspace = `space-${state.workspaces.size}`;
      const pane = `pane-${state.panes.size}`;
      const tab = `tab-${state.panes.size}`;
      state.workspaces.set(workspace, {
        label: "worker",
        cwd: option("--cwd"),
        checkout: option("--path"),
      });
      state.panes.set(pane, { cwd: option("--path"), workspace, tab, status: "idle", prompts: 0 });
      result = ok({
        result: {
          workspace: { workspace_id: workspace },
          tab: { tab_id: tab },
          root_pane: { pane_id: pane },
        },
      });
    } else if (args[0] === "tab" && args[1] === "create") {
      const pane = `pane-${state.panes.size}`;
      const tab = `tab-${state.panes.size}`;
      state.panes.set(pane, {
        cwd: option("--cwd"),
        workspace: option("--workspace"),
        tab,
        status: "idle",
        prompts: 0,
      });
      result = ok({ result: { tab: { tab_id: tab }, root_pane: { pane_id: pane } } });
    } else if (args[0] === "agent" && args[1] === "start") {
      const pane = state.panes.get(option("--pane"))!;
      pane.alias = args[2];
      pane.model = option("--model");
      pane.thinking = option("--thinking");
      result = ok({});
    } else if (args[0] === "agent" && args[1] === "get") {
      const pane = state.panes.get(args[2]!);
      if (!pane)
        return {
          code: 1,
          killed: false,
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_not_found" } }),
        };
      result = ok({
        result: {
          agent: {
            agent: "omp",
            name: pane.alias,
            pane_id: args[2],
            cwd: pane.cwd,
            workspace_id: pane.workspace,
            tab_id: pane.tab,
            agent_status: pane.status,
            completion_seq: pane.completionSeq ?? 0,
            terminal_id: `terminal-${args[2]}`,
            agent_session: state.futureSessionPath
              ? { kind: "path", value: state.futureSessionPath }
              : null,
          },
        },
      });
    } else if (args[0] === "agent" && args[1] === "prompt") {
      const pane = state.panes.get(args[2]!)!;
      pane.prompts++;
      pane.status = state.idleAfterPrompt ? "idle" : "working";
      result = ok({});
    } else if (args[0] === "pane") result = ok({});
    else if (args[0] === "agent" && args[1] === "wait") return await new Promise(() => {});
    else throw new Error(`Unexpected Herdr ${args.join(" ")}`);
    const mutation =
      args[0] === "worktree" ||
      (args[0] === "agent" && ["start", "prompt"].includes(args[1]!)) ||
      (args[0] === "tab" && args[1] === "create");
    if (mutation) state.mutations.set(args[1]!, (state.mutations.get(args[1]!) ?? 0) + 1);
    if (state.lost === args[1] && mutation) {
      state.lost = "";
      return { code: 1, killed: true, stdout: "", stderr: "transport disconnected after effect" };
    }
    return { ...result, killed: false };
  };
  const spawnStdio: NonNullable<ToolAPI["spawnStdio"]> = () => {
    let input = "";
    const { promise: ended, resolve: end } = Promise.withResolvers<void>();
    const reply = (async () => {
      await ended;
      const request = validateHostRequest(JSON.parse(input));
      if (request.op === "report.read") throw new Error("No report stream in launch fixture");
      const host = hosts.get("remote")!;
      if (request.op === "worker.allocate" && host.state.refusedAllocations-- > 0)
        return (
          JSON.stringify({
            protocol: request.protocol,
            version: 1,
            requestId: request.requestId,
            hostId: host.hostId,
            ok: false,
            error: {
              code: "LOCK_BUSY",
              message: "Refused before entering the ledger",
              channel: "helper",
              effect: "none",
              retry: "user_action",
              operationId: request.operationId,
            },
          }) + "\n"
        );
      if (request.op === "worker.allocate" && host.state.lost === "allocate-before") {
        host.state.lost = "";
        throw new Error("request refused before ledger entry; response lost");
      }
      if (request.op === "project.snapshot") await host.state.beforeSnapshot?.();
      const result = await dispatchHostRequest(host.runtime, request);
      if (request.op === "worker.allocate" && host.state.lost === "allocate") {
        host.state.lost = "";
        throw new Error("response lost after allocation");
      }
      return JSON.stringify(result) + "\n";
    })();
    return {
      stdin: {
        write: (data) => {
          input += typeof data === "string" ? data : new TextDecoder().decode(data);
        },
        end,
      },
      stdout: (async function* () {
        yield new TextEncoder().encode(await reply);
      })(),
      stderr: (async function* () {})(),
      exited: reply.then(
        () => 0,
        () => 255,
      ),
      kill: () => {},
    };
  };
  const api: ToolAPI = {
    cwd: controller,
    zod: z,
    exec: controllerExec,
    localHostRuntime: hosts.get("local")!.runtime,
    spawnStdio,
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "fixture", HERDR_PANE_ID: "root:pane" },
    logger: {} as ToolAPI["logger"],
    sendMessage: () => {},
  };
  const state = stateFor(api);
  const tool = taskTool(api);
  // The factory only consumes params/signal; no agent-loop context exists in this fixture.
  const execute = tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<CustomToolResult>;
  return {
    base,
    controller,
    hosts,
    api,
    state,
    tool,
    git,
    run: (params: unknown) => execute("fixture", params),
    registerRemote: async () => {
      const host = hosts.get("remote")!;
      const path = await canonicalPath(host.project);
      await mkdir(join(controller, ".omp"), { recursive: true });
      await writeFile(
        join(controller, ".omp", "projects.json"),
        JSON.stringify({
          version: 2,
          projects: {
            repo: {
              machine: "remote",
              path: path.path,
              pathKey: path.pathKey,
              binding: { sshTarget: "remote-ssh", session: "agents", hostId: host.hostId },
            },
          },
          roots: {},
        }),
      );
    },
    close: async () => {
      disposeWorkers(state);
      state.store.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
