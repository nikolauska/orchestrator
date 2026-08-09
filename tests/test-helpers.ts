import { expect } from "bun:test";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import projectsTool from "../.omp/tools/projects";
import taskTool from "../.omp/tools/orchestrator_task";
import type { ProjectParams, TaskParams, WorkersParams, ExecResult } from "../.omp/runtime/shared";
import workersTool from "../.omp/tools/workers";

type Call = { command: string; args: string[]; cwd?: string };
type Waiter = { resolve: () => void; reject: (error: Error) => void };

type ToolLike = {
  execute(
    toolCallId: string,
    params: unknown,
    onUpdate: unknown,
    context: unknown,
    signal?: AbortSignal,
  ): Promise<CustomToolResult>;
  onSession?: (event: unknown, context: unknown) => void | Promise<void>;
};

export interface ToolHarness {
  runProjects(params: ProjectParams, signal?: AbortSignal): Promise<CustomToolResult>;
  runTask(params: TaskParams, signal?: AbortSignal): Promise<CustomToolResult>;
  runWorkers(params: WorkersParams, signal?: AbortSignal): Promise<CustomToolResult>;
  dispose(): void;
}

export const roots: string[] = [];

export async function cleanup(): Promise<void> {
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
  readonly outputs = new Map<string, string>();
  projectHead = "base";
  projectBranch = "main";
  projectDirty = false;
  rebaseFails = false;
  gitInitFails = false;
  gitCommitFails = false;
  promptStallsOnce = false;
  agentIdentity = "omp";
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
    if (command === "herdr" && args.includes("tab") && args.includes("create")) {
      const name = args[args.indexOf("--label") + 1];
      return this.#ok(
        JSON.stringify({
          result: { tab: { tab_id: `tab-${name}` }, root_pane: { pane_id: `pane:${name}` } },
        }),
      );
    }
    if (command === "herdr" && args.includes("tab") && args.includes("close")) return this.#ok();
    if (command === "herdr" && args.includes("pane") && args.includes("wait-output"))
      return this.#ok("{}");
    if (command === "herdr" && args.includes("agent") && args.includes("start"))
      return this.#ok("{}");
    if (command === "herdr" && args.includes("agent") && args.includes("send-keys")) {
      this.status.set(args[args.indexOf("send-keys") + 1], "working");
      return this.#ok("{}");
    }
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
      return this.#ok(
        JSON.stringify({
          result: {
            agent: { agent: this.agentIdentity, agent_status: this.status.get(pane) ?? "working" },
          },
        }),
      );
    }
    if (command === "herdr" && args.includes("agent") && args.includes("read")) {
      const pane = args[args.indexOf("read") + 1];
      return this.#ok(this.outputs.get(pane) ?? `output ${pane}`);
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
  messages: Array<{ message: string; options: unknown }>,
  env: Record<string, string | undefined> = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "socket",
    HERDR_PANE_ID: "workspace:root",
  },
  neutralRoot?: string,
): ToolHarness {
  const api = {
    cwd: root,
    exec: fake.exec,
    logger: {},
    zod,
    ui: { notify: () => {} },
    sendMessage: (message: string, options: unknown) => messages.push({ message, options }),
    env,
    neutralRoot,
  } as unknown as Parameters<typeof projectsTool>[0];
  const projects = projectsTool(api) as unknown as ToolLike;
  const task = taskTool(api) as unknown as ToolLike;
  const workers = workersTool(api) as unknown as ToolLike;
  const execute = (tool: ToolLike, params: unknown, signal?: AbortSignal) =>
    tool.execute("test", params, undefined, undefined, signal);

  return {
    runProjects: (params, signal) => execute(projects, params, signal),
    runTask: (params, signal) => execute(task, params, signal),
    runWorkers: (params, signal) => execute(workers, params, signal),
    dispose: () => {
      void workers.onSession?.({ reason: "shutdown" }, undefined);
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
