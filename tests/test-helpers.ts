import { expect } from "bun:test";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { CustomToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import orchestratorExtension from "../.omp/extensions/orchestrator";
import projectsTool from "../.omp/extensions/orchestrator/projects";
import taskTool from "../.omp/extensions/orchestrator/orchestrator_task";
import type {
  ProjectParams,
  TaskParams,
  ToolAPI,
  WorkersParams,
  ExecResult,
} from "../.omp/runtime/shared";
import workersTool from "../.omp/extensions/orchestrator/workers";

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
  readonly sessionEntries = new Map<string, unknown[]>();
  readonly sessionless = new Set<string>();
  readonly screens = new Map<string, string>();
  /** Upstream `remote refs/heads/x` per local ref, as `git for-each-ref` reports it. */
  readonly upstreams = new Map<string, string>();
  readonly remoteHeads = new Map<string, string>();
  readonly knownCommits = new Set<string>();
  prUrl = "https://github.com/example/fixture/pull/1";
  prFails = false;
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
      const path = join(this.project, `.treehouse-${name}`);
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
    if (command === "gh" && args[0] === "pr")
      return this.prFails
        ? this.#fail("gh: not authenticated")
        : this.#ok(`Creating\n${this.prUrl}`);
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
    if (args[0] === "init") return this.gitInitFails ? this.#fail("git init failed") : this.#ok();
    if (args[0] === "commit")
      return this.gitCommitFails ? this.#fail("git commit failed") : this.#ok();
    if (args[0] === "check-ref-format")
      return args.at(-1)!.includes(" ") ? this.#fail("invalid ref") : this.#ok();
    if (args[0] === "status") return this.#ok(this.projectDirty ? "dirty" : "");
    if (args[0] === "symbolic-ref") return this.#ok(this.projectBranch);
    if (args[0] !== "-C") return this.#fail(`unexpected git args: ${args.join(" ")}`);
    const path = args[1];
    const sub = args.slice(2);
    if (sub[0] === "reset") return this.#ok();
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
): ToolHarness {
  const api: ToolAPI = {
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
  return harness([projectsTool(api), taskTool(api), workersTool(api)] as unknown as ToolLike[]);
}

// Loads the real extension entry the way OMP does: cwd and Herdr environment come from the process.
export function extensionRuntime(
  root: string,
  fake: FakeExec,
  messages: Message[],
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
    void orchestratorExtension(pi);
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
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>(setImmediate);
    }
  }
  assertion();
}
