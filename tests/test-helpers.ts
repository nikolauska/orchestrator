import { expect } from "bun:test";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { CustomToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { HostFailure, nativeAbsolutePath } from "../.omp/runtime/host-paths";
import { PROTOCOL, validateHostRequest, type HelloResult } from "../.omp/runtime/helper-protocol";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { registerOrchestrator } from "../.omp/extensions/orchestrator";
import machinesTool from "../.omp/extensions/orchestrator/machines";
import { createHostRuntime, type HostRuntime } from "../.omp/runtime/host";
import { WORKER_CONFIG } from "../.omp/runtime/herdr";
import { resolveMachineOmpContext } from "../.omp/runtime/machines";
import { stateFor, disposeWorkers } from "../.omp/extensions/orchestrator/workers";
import projectsTool from "../.omp/extensions/orchestrator/projects";
import taskTool from "../.omp/extensions/orchestrator/orchestrator_task";
import type {
  MachinesParams,
  ProjectParams,
  TaskParams,
  ToolAPI,
  WorkersParams,
  ExecResult,
} from "../.omp/runtime/shared";
import workersTool from "../.omp/extensions/orchestrator/workers";
import modelsTool from "../.omp/extensions/orchestrator/models";
import usageTool from "../.omp/extensions/orchestrator/usage";
import type { HostModelsParams } from "../.omp/extensions/orchestrator/models";
import { targetKey, type ExecutionTarget } from "../.omp/runtime/execution";

export function executionTargetFixture(
  os: ExecutionTarget["os"] = "linux",
  machineId = "local",
): ExecutionTarget {
  const path = os === "win32" ? "C:\\OMP\\runtime" : "/omp/runtime";
  return {
    ...(machineId === "local"
      ? { kind: "local" as const, machineId: "local" as const }
      : { kind: "ssh" as const, machineId, sshTarget: `host-${machineId}` }),
    hostId: crypto.randomUUID(),
    os,
    arch: "x64",
    pathStyle: os === "win32" ? "win32" : "posix",
    session: "agents",
    workerConfig: {
      path: os === "win32" ? "C:\\OMP\\worker-config.yml" : "/omp/worker-config.yml",
      sha256: "a".repeat(64),
    },
    runtimeRoot: { path, pathKey: `runtime:${machineId}` },
    neutralRoot: {
      path: os === "win32" ? "C:\\OMP\\neutral" : "/omp/neutral",
      pathKey: `neutral:${machineId}`,
    },
  };
}

/** Hosts may reuse pane and path strings; fixtures must not merge their mutable state. */
export class FakeTargetHosts {
  readonly hosts = new Map<string, FakeExec>();
  add(target: ExecutionTarget, fake: FakeExec): void {
    this.hosts.set(targetKey(target), fake);
  }
  execFor(target: ExecutionTarget): ToolAPI["exec"] {
    const fake = this.hosts.get(targetKey(target));
    if (!fake) throw new Error("Unknown fixture target");
    return fake.exec as ToolAPI["exec"];
  }
}

type Call = { command: string; args: string[]; cwd?: string };
type Waiter = { resolve: () => void; reject: (error: Error) => void };
export type FakeWorkspace = {
  workspace_id: string;
  label: string;
  cwd?: string;
  checkout?: string;
  worktree?: { repo_root: string; is_linked_worktree: boolean; checkout_path?: string };
};

type ToolLike = {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ): Promise<CustomToolResult>;
  onSession?: (event: unknown, context: unknown) => void | Promise<void>;
};

type Message = { message: string; options: unknown };

export interface ToolHarness {
  runProjects(params: ProjectParams, signal?: AbortSignal): Promise<CustomToolResult>;
  runTask(params: TaskParams, signal?: AbortSignal): Promise<CustomToolResult>;
  runWorkers(params: WorkersParams, signal?: AbortSignal): Promise<CustomToolResult>;
  runModels(params: HostModelsParams, signal?: AbortSignal): Promise<CustomToolResult>;
  runMachines(params: MachinesParams, signal?: AbortSignal): Promise<CustomToolResult>;
  runUsage(
    params: { machine?: string; project?: string },
    signal?: AbortSignal,
  ): Promise<CustomToolResult>;
  dispose(): void;
}

export const roots: string[] = [];
const restores: Array<() => void> = [];

export async function cleanup(): Promise<void> {
  for (const restore of restores.splice(0).reverse()) restore();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "visible-workers-test-"));
  const project = join(root, "project");
  await mkdir(project);
  roots.push(root);
  return { root, project };
}

export class FakeExec {
  readonly calls: Call[] = [];
  readonly waits = new Map<string, Waiter>();
  readonly status = new Map<string, string>();
  readonly workerHeads = new Map<string, string>();
  readonly branchHeads = new Map<string, string>([["main", "base"]]);
  readonly dirtyWorkers = new Set<string>();
  readonly ancestors = new Set<string>();
  readonly outputs = new Map<string, string>();
  readonly createdProjects = new Set<string>();
  readonly sessionEntries = new Map<string, unknown[]>();
  readonly sessionless = new Set<string>();
  readonly screens = new Map<string, string>();
  /** Upstream `remote refs/heads/x` per local ref, as `git for-each-ref` reports it. */
  readonly upstreams = new Map<string, string>();
  /** `omp models --json` catalog; one id carries its own `:free` suffix like OpenRouter's. */
  models: unknown[] = [
    {
      provider: "anthropic",
      kind: "chat",
      selector: "anthropic/claude-opus-5-5",
      thinking: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      provider: "openrouter",
      kind: "chat",
      selector: "openrouter/qwen/qwen3-coder:free",
      thinking: null,
    },
  ];
  usage: unknown = { reports: [], capacity: {} };
  modelRoles: Record<string, string> = {};
  readonly remoteHeads = new Map<string, string>();
  readonly knownCommits = new Set<string>();
  projectHead = "base";
  projectBranch = "main";
  projectDirty = false;
  rebaseFails = false;
  gitInitFails = false;
  gitCommitFails = false;
  promptStallsOnce = false;
  shellWaitFails = false;
  spaceCloseFails = false;
  agentIdentity = "omp";
  readonly goneAgents = new Set<string>();
  readonly workspaces: FakeWorkspace[] = [];
  #reportedPromptStall = false;
  readonly project: string;
  leaseRoot?: string;

  constructor(project: string) {
    this.project = project;
  }

  exec = async (
    command: string,
    args: string[],
    options: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<ExecResult> => {
    this.calls.push({ command, args: [...args], cwd: options.cwd });
    if (args[0] === "--version") return this.#ok(`${command} 1.0`);
    if (command === "treehouse" && args[0] === "get") {
      const name = args[args.indexOf("--lease-holder") + 1].split(":").at(-1)!;
      const path = join(this.leaseRoot ?? this.project, `.treehouse-${name}`);
      await mkdir(path, { recursive: true });
      this.workerHeads.set(path, `head-${name}`);
      const hex = this.workerHeads.size.toString(16).padStart(32, "0");
      return this.#ok(
        JSON.stringify({ path, lease_id: hex, lease_holder: `omp-orchestrator:${name}` }),
      );
    }
    if (command === "treehouse" && args[0] === "return") return this.#ok();
    if (command === "herdr") {
      const space = this.#space(args);
      if (space) return space;
    }
    if (command === "herdr" && args.includes("pane") && args.includes("wait-output"))
      return this.shellWaitFails ? this.#fail("shell unavailable") : this.#ok("{}");
    if (command === "herdr" && args.includes("agent") && args.includes("start"))
      return this.#ok("{}");
    if (command === "herdr" && args.includes("agent") && args.includes("send-keys")) {
      const pane = args[args.indexOf("send-keys") + 1];
      this.status.set(pane, args.at(-1) === "esc" ? "idle" : "working");
      return this.#ok("{}");
    }
    if (command === "herdr" && args.includes("agent") && args.includes("read"))
      return this.#ok(this.screens.get(args[args.indexOf("read") + 1]) ?? "");
    if (command === "herdr" && args.includes("agent") && args.includes("prompt")) {
      const pane = args[args.indexOf("prompt") + 1];
      if (this.promptStallsOnce && !this.#reportedPromptStall) {
        this.#reportedPromptStall = true;
        return this.#fail("agent_prompt_stalled");
      }
      this.status.set(pane, "working");
      return this.#ok("{}");
    }
    if (command === "herdr" && args.includes("agent") && args.includes("get")) {
      const pane = args.at(-1)!;
      if (this.goneAgents.has(pane))
        return this.#fail(
          `{"error":{"code":"agent_not_found","message":"agent target ${pane} not found"}}`,
        );
      return this.#ok(
        JSON.stringify({
          result: {
            agent: {
              agent: this.agentIdentity,
              agent_status: this.status.get(pane) ?? "working",
              agent_session: this.sessionless.has(pane)
                ? null
                : {
                    agent: "omp",
                    kind: "path",
                    source: "herdr:omp",
                    value: await this.#session(pane),
                  },
            },
          },
        }),
      );
    }
    if (command === "herdr" && args.includes("agent") && args.includes("wait")) {
      const pane = args[args.indexOf("wait") + 1];
      if (args.includes("--timeout")) return this.#ok("{}");
      return await new Promise<ExecResult>((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (options.signal?.aborted) return abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        this.waits.set(pane, { resolve: () => resolve(this.#ok("{}")), reject });
      });
    }
    if (command === "omp" && args[0] === "models")
      return this.#ok(JSON.stringify({ models: this.models }));
    if (command === "omp" && args[0] === "usage") return this.#ok(JSON.stringify(this.usage));
    if (command === "omp" && args[0] === "config")
      return this.#ok(JSON.stringify({ key: args[2], value: this.modelRoles }));
    if (command === "git") return this.#git(args, options.cwd);
    return this.#fail(`unexpected command: ${command} ${args.join(" ")}`);
  };

  settle(name: string, status = "done") {
    const pane = `pane:${name}`;
    this.status.set(pane, status);
    const waiter = this.waits.get(pane);
    if (!waiter) throw new Error(`No waiter for ${name}`);
    this.waits.delete(pane);
    waiter.resolve();
  }

  async #session(pane: string): Promise<string> {
    const path = join(dirname(this.project), "sessions", `${pane.replace(":", "-")}.jsonl`);
    const entries = this.sessionEntries.get(pane) ?? [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: this.outputs.get(pane) ?? `output ${pane}` }],
        },
      },
    ];
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return path;
  }

  #git(args: string[], cwd?: string): ExecResult {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return this.#ok(cwd ?? this.project);
    if (args[0] === "rev-parse" && args[1] === "HEAD") return this.#ok(this.projectHead);
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const branch = args[2]?.replace("refs/heads/", "");
      const head = branch && this.branchHeads.get(branch);
      return head ? this.#ok(head) : this.#fail("unknown branch");
    }
    if (args[0] === "init") {
      if (this.gitInitFails) return this.#fail("git init failed");
      this.createdProjects.add(args[1] ?? cwd!);
      return this.#ok();
    }
    if (args[0] === "commit")
      return this.gitCommitFails ? this.#fail("git commit failed") : this.#ok();
    if (args[0] === "check-ref-format")
      return args.at(-1)!.includes(" ") ? this.#fail("invalid ref") : this.#ok();
    if (args[0] === "status") return this.#ok(this.projectDirty ? "dirty" : "");
    if (args[0] === "symbolic-ref") return this.#ok(this.projectBranch);
    if (args[0] !== "-C") return this.#fail(`unexpected git args: ${args.join(" ")}`);
    const path = args[1];
    const sub = args.slice(2);
    if (sub[0] === "rev-parse" && sub[1] === "--show-toplevel") return this.#ok(path);
    if (sub[0] === "commit")
      return this.gitCommitFails ? this.#fail("git commit failed") : this.#ok();
    if (sub[0] === "rev-parse" && sub[1] === "HEAD" && this.createdProjects.has(path))
      return this.#ok("a".repeat(40));
    if (sub[0] === "reset") {
      this.workerHeads.set(path, sub.at(-1)!);
      return this.#ok();
    }
    if (sub[0] === "rev-parse" && sub.includes("--git-common-dir")) return this.#ok(this.project);
    if (sub[0] === "rev-parse" && sub[1] === "--symbolic-full-name")
      return this.#ok(this.projectBranch ? `refs/heads/${this.projectBranch}` : "HEAD");
    if (sub[0] === "for-each-ref") return this.#ok(this.upstreams.get(sub.at(-1)!) ?? "");
    if (sub[0] === "ls-remote") {
      const head = this.remoteHeads.get(sub.at(-1)!);
      return head ? this.#ok(`${head}\t${sub.at(-1)}`) : this.#fail("no remote ref");
    }
    if (sub[0] === "cat-file")
      return this.knownCommits.has(sub.at(-1)!.replace("^{commit}", ""))
        ? this.#ok()
        : this.#fail("missing");
    if (sub[0] === "rev-list") return this.#ok("3");
    if (sub[0] === "status")
      return this.#ok(
        path === this.project
          ? this.projectDirty
            ? "dirty"
            : ""
          : this.dirtyWorkers.has(path)
            ? "dirty"
            : "",
      );
    if (sub[0] === "symbolic-ref") return this.#ok(this.projectBranch);
    if (sub[0] === "rev-parse")
      return this.#ok(
        path === this.project ? this.projectHead : (this.workerHeads.get(path) ?? "missing"),
      );
    if (sub[0] === "merge-base" && sub[1] === "--is-ancestor")
      return this.ancestors.has(`${sub[2]}:${sub[3]}`) ? this.#ok() : this.#fail("not ancestor");
    if (sub[0] === "merge") {
      const head = sub.at(-1)!;
      if (this.projectHead !== "base" && !head.startsWith("rebased-"))
        return this.#fail("not a fast-forward");
      this.projectHead = head;
      return this.#ok();
    }
    if (sub[0] === "rebase" && sub[1] === "--abort") return this.#ok();
    if (sub[0] === "rebase") {
      if (this.rebaseFails) return this.#fail("conflict");
      this.workerHeads.set(path, `rebased-${path.split("-").at(-1)}`);
      return this.#ok();
    }
    if (sub[0] === "push") return this.#ok();
    return this.#fail(`unexpected git -C: ${sub.join(" ")}`);
  }

  /** Mirrors Herdr's grouping: a worktree nests under the repository's space, adopting a plain one. */
  #space(args: string[]): ExecResult | undefined {
    const option = (name: string) => args[args.indexOf(name) + 1]!;
    const worker = (label: string) => label.split("·").at(-1)!;
    const [group, action] = args;
    if (group === "workspace" && action === "list")
      return this.#ok(JSON.stringify({ result: { workspaces: this.workspaces } }));
    if (group === "workspace" && action === "create") {
      const label = option("--label");
      const id = `space-${label}`;
      this.workspaces.push({ workspace_id: id, label, cwd: option("--cwd") });
      return this.#ok(
        JSON.stringify({
          result: {
            workspace: { workspace_id: id },
            tab: { tab_id: `${id}:t1` },
            root_pane: { pane_id: `${id}:p1` },
          },
        }),
      );
    }
    if (group === "workspace" && action === "rename") {
      this.workspaces.find((item) => item.workspace_id === args[2])!.label = args[3]!;
      return this.#ok();
    }
    if (group === "workspace" && action === "close") {
      if (this.spaceCloseFails) return this.#fail("close failed");
      const index = this.workspaces.findIndex((item) => item.workspace_id === args[2]);
      if (index < 0)
        return this.#fail(`{"error":{"code":"workspace_not_found","message":"missing"}}`);
      this.workspaces.splice(index, 1);
      return this.#ok();
    }
    if (group === "worktree" && action === "open") {
      const repository = option("--cwd");
      const checkout = option("--path");
      const label = basename(checkout);
      const open = this.workspaces.find((item) => item.checkout === checkout);
      if (open) return this.#ok(JSON.stringify({ result: { already_open: true } }));
      const parent =
        this.workspaces.find((item) => item.worktree?.repo_root === repository) ??
        this.workspaces.find((item) => !item.worktree && item.cwd === repository);
      if (parent) parent.worktree = { repo_root: repository, is_linked_worktree: false };
      else
        this.workspaces.push({
          workspace_id: "space-parent",
          label: basename(repository),
          worktree: { repo_root: repository, is_linked_worktree: false },
        });
      const name = label.split("-").at(-1)!;
      this.workspaces.push({
        workspace_id: `space-${name}`,
        label,
        checkout,
        worktree: { repo_root: repository, is_linked_worktree: true, checkout_path: checkout },
      });
      return this.#ok(
        JSON.stringify({
          result: {
            already_open: false,
            workspace: { workspace_id: `space-${name}` },
            tab: { tab_id: `tab-${name}` },
            root_pane: { pane_id: `pane:${name}` },
          },
        }),
      );
    }
    if (group === "tab" && action === "create") {
      const name = worker(option("--label"));
      return this.#ok(
        JSON.stringify({
          result: { tab: { tab_id: `tab-${name}` }, root_pane: { pane_id: `pane:${name}` } },
        }),
      );
    }
    if (group === "tab" && action === "close") return this.#ok();
    return undefined;
  }
  #ok(stdout = ""): ExecResult {
    return { stdout, stderr: "", code: 0 };
  }
  #fail(stderr: string): ExecResult {
    return { stdout: "", stderr, code: 1 };
  }
}

export function fixtureHost(
  root: string,
  deps: Pick<ToolAPI, "exec" | "logger" | "sendMessage">,
): HostRuntime {
  const runtimeRoot = `${root}-host-runtime`;
  const neutralRoot = `${root}-host-neutral`;
  roots.push(runtimeRoot, neutralRoot);
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(neutralRoot, { recursive: true });
  const tools = join(root, "host-tools");
  mkdirSync(tools, { recursive: true });
  for (const name of ["git", "treehouse", "omp", "herdr"])
    writeFileSync(join(tools, name), "", { mode: 0o700 });
  return createHostRuntime(
    {
      version: 1,
      hostId: "11111111-1111-4111-8111-111111111111",
      overlayPath: WORKER_CONFIG,
      runtimeRoot,
      neutralRoot,
      queryCwd: root,
      approvedProjectRoots: [],
      executables: {
        git: { executable: join(tools, "git"), prefixArgs: [] },
        treehouse: { executable: join(tools, "treehouse"), prefixArgs: [] },
        omp: { executable: join(tools, "omp"), prefixArgs: [] },
      },
    },
    {
      ...deps,
      exec: (command, args, options) => {
        if (basename(command) === "omp" && args[0] === "config" && args[1] === "path")
          return Promise.resolve({ code: 0, killed: false, stderr: "", stdout: root });
        return deps.exec(
          basename(command),
          args.filter((arg) => !arg.startsWith("--config=")),
          options,
        );
      },
    },
    {
      local: true,
      sessionRoots: [join(root, "sessions")],
      discoverExecutable: (name) => join(tools, name),
    },
  );
}

export function runtime(
  root: string,
  fake: FakeExec,
  messages: Message[],
  env: Record<string, string | undefined> = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "socket",
    HERDR_PANE_ID: "workspace:root",
  },
  neutralRoot?: string,
  services: Pick<ToolAPI, "target" | "spawnStdio" | "localHostRuntime"> = {},
): ToolHarness {
  const api: ToolAPI = {
    ...services,
    cwd: root,
    exec: fake.exec as unknown as ToolAPI["exec"],
    logger: {} as ToolAPI["logger"],
    zod,
    sendMessage: (message, options) => {
      messages.push({ message, options });
    },
    env,
    neutralRoot,
  };
  api.localHostRuntime ??= fixtureHost(root, api);
  api.resolveOmpContext = (machine, signal) =>
    resolveMachineOmpContext(api, machine, {
      controllerId: stateFor(api).store.controllerId,
      signal,
    });
  if (neutralRoot) {
    mkdirSync(neutralRoot, { recursive: true });
    api.localHostRuntime.configuration.neutralRoot = neutralRoot;
  }
  restores.push(() => {
    const state = stateFor(api);
    disposeWorkers(state);
    state.store.close();
  });
  return harness([
    projectsTool(api),
    machinesTool(api),
    taskTool(api),
    workersTool(api),
    modelsTool(api),
    usageTool(api),
  ] as unknown as ToolLike[]);
}

// Loads the real extension entry the way OMP does: cwd and Herdr environment come from the process.
export function extensionRuntime(
  root: string,
  fake: FakeExec,
  messages: Message[],
  services: Pick<ToolAPI, "spawnStdio"> = {},
): { instance: ToolHarness; registered: string[] } {
  const previousCwd = process.cwd();
  const herdr = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"] as const;
  const previousEnv = herdr.map((key) => [key, process.env[key]] as const);
  restores.push(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "socket",
    HERDR_PANE_ID: "workspace:root",
  });

  const tools: ToolLike[] = [];
  const pi = {
    exec: fake.exec,
    logger: {},
    zod,
    registerTool: (tool: ToolLike) => tools.push(tool),
    sendMessage: (message: string, options: unknown) => messages.push({ message, options }),
  } as unknown as ExtensionAPI;
  process.chdir(root);
  try {
    const api = registerOrchestrator(pi, {
      ...services,
      localHostRuntime: fixtureHost(root, {
        exec: fake.exec as ToolAPI["exec"],
        logger: {},
        sendMessage: () => {},
      }),
    });
    restores.push(() => {
      const state = stateFor(api);
      disposeWorkers(state);
      state.store.close();
    });
  } finally {
    process.chdir(previousCwd);
  }
  return { instance: harness(tools), registered: tools.map((tool) => tool.name) };
}

function harness(tools: ToolLike[]): ToolHarness {
  const tool = (name: string) => {
    const found = tools.find((item) => item.name === name);
    if (!found) throw new Error(`tool ${name} is not registered`);
    return found;
  };
  const execute = (name: string, params: unknown, signal?: AbortSignal) =>
    tool(name).execute("test", params, signal, undefined, undefined);

  return {
    runProjects: (params, signal) => execute("projects", params, signal),
    runTask: (params, signal) => execute("orchestrator_task", params, signal),
    runWorkers: (params, signal) => execute("workers", params, signal),
    runModels: (params, signal) => execute("models", params, signal),
    runMachines: (params, signal) => execute("machines", params, signal),
    runUsage: (params, signal) => execute("usage", params, signal),
    dispose: () => {
      void tool("workers").onSession?.({ reason: "shutdown" }, undefined);
    },
  };
}

export async function register(instance: ToolHarness, project: string, name = "fixture") {
  const result = await instance.runProjects({ op: "add", name, path: project });
  expect(result.isError).toBeUndefined();
}

export async function launchedPair() {
  const { root, project } = await fixtureRoot();
  const fake = new FakeExec(project);
  const messages: Array<{ message: string; options: unknown }> = [];
  const instance = runtime(root, fake, messages);
  await register(instance, project);
  const result = await instance.runTask({
    project: "fixture",
    context: "shared",
    tasks: [
      { kind: "implementation", name: "alpha", task: "A" },
      { kind: "implementation", name: "beta", task: "B" },
    ],
  });
  return { root, project, fake, messages, instance, result };
}

export async function launchedScout() {
  const { root, project } = await fixtureRoot();
  const fake = new FakeExec(project);
  const messages: Array<{ message: string; options: unknown }> = [];
  const instance = runtime(root, fake, messages);
  await register(instance, project);
  const result = await instance.runTask({
    project: "fixture",
    context: "shared",
    tasks: [{ kind: "scout", name: "scout", task: "Investigate" }],
  });
  const launched = (result.details as Array<Record<string, unknown>>)[0];
  return {
    root,
    project,
    fake,
    messages,
    instance,
    result,
    launched,
    reportPath: launched.report_path as string,
  };
}

export async function launchedIndependent(
  tasks = [{ kind: "scout" as const, name: "independent", task: "Research vendors" }],
) {
  const { root, project } = await fixtureRoot();
  const neutralRoot = `${root}-neutral`;
  roots.push(neutralRoot);
  const fake = new FakeExec(project);
  const messages: Array<{ message: string; options: unknown }> = [];
  const instance = runtime(root, fake, messages, undefined, neutralRoot);
  const result = await instance.runTask({ scope: "independent", context: "shared", tasks });
  return { root, neutralRoot, fake, messages, instance, result };
}

export async function eventually(assertion: () => void) {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>(setImmediate);
    }
  }
  assertion();
}

export type RemoteFixtureHost = {
  hostId: string;
  os: "linux" | "darwin" | "win32";
  root: string;
  files: Map<string, { path: string; pathKey: string; git: boolean; head?: string }>;
  offline: boolean;
  herdrOffline: boolean;
  failCreate: boolean;
  integration: string;
  integrationUnavailable?: boolean;
  overlaySha256: string;
  catalog: {
    selector: string;
    provider: string;
    id: string;
    thinking: string[];
    input: string[];
  }[];
  remainingAccounts: number;
  accounts: number;
};
export async function machineFixture(root: string, project: string) {
  const fake = new FakeExec(project);
  const overlaySha256 = createHash("sha256")
    .update(await readFile(WORKER_CONFIG))
    .digest("hex");
  const profiles = [
    {
      id: "workbox",
      label: "Build machine",
      target: "workbox-ssh",
      session: "agents",
      enabled: true,
    },
    { id: "alias", label: "Alias", target: "alias-ssh", session: "other", enabled: true },
    { id: "windows", label: "Windows", target: "windows-ssh", session: "agents", enabled: true },
    { id: "mac", label: "Mac", target: "mac-ssh", session: "agents", enabled: true },
  ];
  const hosts = new Map<string, RemoteFixtureHost>();
  for (const [target, os, hostId] of [
    ["workbox-ssh", "linux", "22222222-2222-4222-8222-222222222222"],
    ["windows-ssh", "win32", "33333333-3333-4333-8333-333333333333"],
    ["mac-ssh", "darwin", "44444444-4444-4444-8444-444444444444"],
  ] as const) {
    const path = os === "win32" ? "D:\\Dev\\Nïko Projects" : "/srv/projects";
    const files: RemoteFixtureHost["files"] = new Map([
      [path, { path, pathKey: "root", git: false }],
    ]);
    const repo = os === "win32" ? `${path}\\repo` : `${path}/repo`;
    files.set(repo, { path: repo, pathKey: "repo", git: true, head: "a".repeat(40) });
    const id = `${os}-only`;
    hosts.set(target, {
      hostId,
      os,
      root: path,
      files,
      offline: false,
      herdrOffline: false,
      failCreate: false,
      integration: "3",
      overlaySha256,
      catalog: [
        {
          selector: `openai-codex/${id}`,
          provider: "openai-codex",
          id,
          thinking: ["low", "high"],
          input: ["text"],
        },
      ],
      remainingAccounts: 0.73,
      accounts: 1,
    });
  }
  hosts.set("alias-ssh", hosts.get("workbox-ssh")!);
  const helperCalls: { target: string; op: string }[] = [];
  fake.modelRoles = { default: "anthropic/claude-opus-5-5" };
  const original = fake.exec;
  const server = (session: string) => ({
    running: true,
    compatible: true,
    endpoint_compatible: true,
    session,
    version: "0.9.3",
    protocol: 22,
    capabilities: { endpoint_protocol_generation: 1, health_check: true },
  });
  fake.exec = async (command, args, options) => {
    const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    if (command === "herdr") {
      if (args[0] === "machine" && args[1] === "list") return ok(profiles);
      if (args[0] === "machine" && args[1] === "status") {
        const profile = profiles.find((profile) => profile.id === args[2]);
        const reachable = profile && !hosts.get(profile.target)?.herdrOffline;
        return {
          ...ok([
            {
              id: profile?.id,
              label: profile?.label,
              status: reachable ? "reachable" : "error",
              error: reachable ? null : "offline",
            },
          ]),
          code: reachable ? 0 : 1,
        };
      }
      if (args[0] === "--machine") {
        const profile = profiles.find((profile) => profile.id === args[1])!;
        if (hosts.get(profile.target)?.herdrOffline)
          return { code: 1, stdout: "", stderr: "ssh unavailable" };
        if (args[2] === "status") return ok(server(profile.session));
        if (args[2] === "api") return ok({ result: { snapshot: { agents: [], workspaces: [] } } });
      }
      if (args[0] === "status") return ok(server("default"));
      if (args[0] === "--session" && args[2] === "status") return ok(server(args[1]));
      if (args.includes("api")) return ok({ result: { snapshot: { agents: [], workspaces: [] } } });
      if (args[0] === "integration") return { code: 0, stdout: "omp: current (v3)", stderr: "" };
    }
    return original(command, args, options);
  };
  const spawnStdio: NonNullable<ToolAPI["spawnStdio"]> = (command) => {
    const target = command.at(-2)!;
    const host = hosts.get(target);
    let input = "";
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const reply = async () => {
      await ended;
      if (!host || host.offline) throw new Error("SSH offline");
      const request = validateHostRequest(JSON.parse(input));
      helperCalls.push({ target, op: request.op });
      const envelope = {
        protocol: PROTOCOL,
        version: 1,
        requestId: request.requestId,
        hostId: host.hostId,
      };
      const hello: HelloResult = {
        hostId: host.hostId,
        os: host.os,
        arch: "x64",
        helperVersion: "1",
        buildId: "fixture",
        capabilities: ["path.validate", "project.create", "preflight"],
        maxFrameBytes: 1048576,
        reportChunkBytes: 65536,
      };
      try {
        if (request.expectedHostId && request.expectedHostId !== host.hostId)
          throw new HostFailure("HOST_MISMATCH", "Saved host changed");
        let result: unknown;
        switch (request.op) {
          case "hello":
            result = hello;
            break;
          case "path.validate": {
            const path = nativeAbsolutePath(request.args.path, { os: host.os, home: host.root });
            const file = host.files.get(path);
            if (!file || (request.args.kind === "git_root" && !file.git))
              throw new HostFailure("PATH_INVALID", "Not an exact Git root or existing directory");
            const canonical = { path: file.path, pathKey: file.pathKey };
            result = {
              path: canonical,
              ...(request.args.kind === "git_root" ? { gitRoot: canonical } : {}),
            };
            break;
          }
          case "project.create": {
            const path = nativeAbsolutePath(request.args.path, { os: host.os, home: host.root });
            if (host.files.has(path))
              throw new HostFailure("DESTINATION_CONFLICT", "Destination exists");
            const file = {
              path,
              pathKey: `created:${host.files.size}`,
              git: !host.failCreate,
              head: host.failCreate ? undefined : "b".repeat(40),
            };
            host.files.set(path, file);
            if (host.failCreate)
              throw new HostFailure("COMMAND_FAILED", `Partial repository retained at ${path}`, {
                operationId: request.operationId,
                effect: "unknown",
                retry: "reconcile",
              });
            result = {
              registrationId: request.args.registrationId,
              project: { path, pathKey: file.pathKey },
              head: file.head,
            };
            break;
          }
          case "omp.context": {
            if (request.args.requiredOverlaySha256 !== host.overlaySha256)
              throw new HostFailure("CONFIG_MISMATCH", "Query overlay bytes differ");
            result = {
              context: {
                cwd: host.root,
                overlayPath:
                  host.os === "win32" ? "D:\\OMP\\worker-config.yml" : "/opt/omp/worker-config.yml",
                overlaySha256: host.overlaySha256,
              },
            };
            break;
          }
          case "preflight": {
            if (host.integrationUnavailable)
              throw new HostFailure(
                "PREREQUISITE_MISSING",
                "Herdr integration inspection unavailable",
              );
            if (request.args.requiredOverlaySha256 !== host.overlaySha256)
              throw new HostFailure("CONFIG_MISMATCH", "Overlay bytes differ, including CRLF/LF");
            const windows = host.os === "win32";
            result = {
              host: hello,
              context: {
                cwd: host.root,
                overlayPath: windows ? "D:\\OMP\\worker-config.yml" : "/opt/omp/worker-config.yml",
                overlaySha256: host.overlaySha256,
              },
              runtimeRoot: {
                path: windows ? "D:\\OMP\\runtime" : "/var/omp/runtime",
                pathKey: "runtime",
              },
              neutralRoot: {
                path: windows ? "D:\\OMP\\neutral" : "/var/omp/neutral",
                pathKey: "neutral",
              },
              overlaySha256: host.overlaySha256,
              tools: [
                { name: "omp", available: true, version: "18.4.4", capabilities: [] },
                {
                  name: "herdr-omp-integration",
                  available: true,
                  version: host.integration,
                  capabilities: [],
                },
              ],
            };
            break;
          }
          case "omp.models":
          case "omp.usage": {
            const context = request.args.context;
            if (context.overlaySha256 !== host.overlaySha256)
              throw new HostFailure("CONFIG_MISMATCH", "Query overlay changed");
            const directory = host.files.get(context.cwd);
            if (!directory) throw new HostFailure("PATH_INVALID", "Unknown query cwd");
            const catalog = directory.git
              ? host.catalog.map((model) => ({
                  ...model,
                  id: `${model.id}-project`,
                  selector: `${model.selector}-project`,
                }))
              : host.catalog;
            const roles = { default: catalog[0]!.selector };
            result =
              request.op === "omp.models"
                ? { context, catalog, roles, defaultChoice: { model: roles.default } }
                : {
                    context,
                    generated_at: new Date(
                      request.op === "omp.usage" ? request.args.now : 0,
                    ).toISOString(),
                    providers: [
                      {
                        provider: "openai-codex",
                        roles: ["default"],
                        accounts: [{ account: `${host.os}*`, windows: [] }],
                        capacity: [
                          {
                            window: "5h",
                            accounts: host.accounts,
                            remaining_accounts: host.remainingAccounts,
                          },
                        ],
                      },
                    ],
                    roles,
                  };
            break;
          }
          default:
            throw new HostFailure("INVALID_REQUEST", "Unexpected fixture operation");
        }
        return { ...envelope, ok: true, result };
      } catch (error) {
        if (!(error instanceof HostFailure)) throw error;
        return { ...envelope, ok: false, error: error.detail };
      }
    };
    return {
      stdin: {
        write: (data) => {
          input += typeof data === "string" ? data : new TextDecoder().decode(data);
        },
        end,
      },
      stdout: (async function* () {
        yield new TextEncoder().encode(`${JSON.stringify(await reply())}\n`);
      })(),
      stderr: (async function* () {})(),
      exited: ended.then(() => 0),
      kill: () => end(),
    };
  };
  const instance = runtime(root, fake, [], undefined, undefined, { spawnStdio });
  return { fake, profiles, hosts, helperCalls, spawnStdio, instance };
}
