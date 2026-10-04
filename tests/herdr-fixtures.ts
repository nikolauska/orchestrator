import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  FakeExec,
  fixtureRoot,
  register,
  roots,
  runtime as baseRuntime,
  extensionRuntime as baseExtensionRuntime,
} from "./test-helpers";
import type { ExecResult } from "../.omp/runtime/shared";

export { FakeExec };
const attached = new WeakSet<FakeExec>();
function attachHerdr(fake: FakeExec, root: string): void {
  if (attached.has(fake)) return;
  attached.add(fake);
  const original = fake.exec;
  const leases: Array<{ path: string; lease_id: string; lease_holder: string }> = [];
  fake.leaseRoot = `${root}-leases`;
  roots.push(fake.leaseRoot);
  if (fake.projectHead === "base") fake.projectHead = "a".repeat(40);
  fake.branchHeads.set("main", fake.projectHead);
  const labels = new Map<string, string>();
  const sha = (label: string) => {
    if (/^[a-f0-9]{40}$/.test(label)) return label;
    const value = createHash("sha1").update(label).digest("hex");
    labels.set(value, label);
    return value;
  };
  const panes = new Map<
    string,
    { cwd: string; workspaceId: string; tabId: string; name?: string }
  >();
  fake.modelRoles = {
    default: "anthropic/claude-opus-5-5",
    smol: "anthropic/claude-opus-5-5",
    ...fake.modelRoles,
  };
  fake.exec = async (command, input, options) => {
    const args = input[0] === "--session" ? input.slice(2) : input;
    const ok = (value: unknown): ExecResult => ({
      code: 0,
      stdout: JSON.stringify(value),
      stderr: "",
    });
    if (command === "herdr" && args[0] === "status")
      return ok({
        running: true,
        compatible: true,
        endpoint_compatible: true,
        session: null,
        version: "0.9.3",
        protocol: 22,
        capabilities: { endpoint_protocol_generation: 1, health_check: true },
      });
    if (command === "herdr" && args[0] === "api")
      return ok({
        result: {
          snapshot: {
            agents: [],
            workspaces: fake.workspaces,
            panes: [...panes].map(([pane_id, pane]) => ({
              pane_id,
              cwd: pane.cwd,
              workspace_id: pane.workspaceId,
              tab_id: pane.tabId,
              terminal_id: `terminal:${pane_id}`,
              agent: fake.goneAgents.has(pane_id) ? "none" : "omp",
            })),
            tabs: [...panes.values()].map((pane) => ({ tab_id: pane.tabId })),
          },
        },
      });
    if (command === "herdr" && args[0] === "integration")
      return { code: 0, stdout: "omp: current (v10) (host overlay)", stderr: "" };
    if (command === "herdr" && args[0] === "agent" && args[1] === "get" && !panes.has(args[2]!))
      return {
        code: 1,
        stdout: "",
        stderr: JSON.stringify({ error: { code: "agent_not_found" } }),
      };
    if (command === "treehouse" && args.includes("--help"))
      return {
        code: 0,
        stdout: "--lease-holder --json --if-lease-id --if-lease-holder",
        stderr: "",
      };
    if (command === "treehouse" && args[0] === "status") return ok(leases);
    if (command === "treehouse" && args[0] === "get") {
      const holder = args[args.indexOf("--lease-holder") + 1]!;
      const db = new Database(join(root, ".omp", "orchestrator.db"), { readonly: true });
      const row = db
        .query("SELECT name FROM workers WHERE launch_id = ?")
        .get(holder.split(":").at(-1)!) as { name: string };
      db.close();
      const translated = [...args];
      translated[args.indexOf("--lease-holder") + 1] = `omp-orchestrator:${row.name}`;
      const result = await original(command, translated, options);
      if (result.code !== 0) return result;
      const lease = { ...JSON.parse(result.stdout), lease_holder: holder };
      leases.push(lease);
      return ok(lease);
    }
    if (command === "treehouse" && args[0] === "return") {
      const index = leases.findIndex(
        (lease) =>
          lease.lease_id === args[args.indexOf("--if-lease-id") + 1] &&
          lease.lease_holder === args[args.indexOf("--if-lease-holder") + 1],
      );
      if (index < 0) return { code: 1, stdout: "", stderr: "lease mismatch" };
      leases.splice(index, 1);
    }
    if (command === "git" && args.includes("merge-base")) {
      const left = labels.get(args.at(-2)!) ?? args.at(-2)!;
      const right = labels.get(args.at(-1)!) ?? args.at(-1)!;
      const inherited =
        left === right ||
        (left === "a".repeat(40) && right.startsWith("head-")) ||
        (fake.projectHead === "a".repeat(40) &&
          left === fake.projectHead &&
          right.startsWith("head-")) ||
        fake.ancestors.has(`${left}:${right}`);
      return { code: inherited ? 0 : 1, stdout: "", stderr: "" };
    }
    if (command === "git" && args.includes("get-url"))
      return { code: 0, stdout: "/fixture-origin", stderr: "" };
    if (command === "git" && args.includes("ls-remote")) {
      const ref = args.at(-1)!;
      const value = fake.remoteHeads.get(ref);
      return { code: 0, stdout: value ? `${sha(value)}\t${ref}` : "", stderr: "" };
    }
    if (command === "git" && args[0] === "-C" && args.includes("merge")) {
      if (fake.projectHead === "a".repeat(40)) fake.projectHead = "base";
    }
    const result = await original(
      command,
      command === "git"
        ? args.map((arg) => {
            const suffix = arg.endsWith("^{commit}") ? "^{commit}" : "";
            const value = suffix ? arg.slice(0, -suffix.length) : arg;
            return (labels.get(value) ?? value) + suffix;
          })
        : args,
      options,
    );
    if (
      command === "git" &&
      args.includes("rev-parse") &&
      !args.includes("--show-toplevel") &&
      !args.includes("--git-common-dir") &&
      !args.includes("--symbolic-full-name") &&
      result.code === 0
    )
      result.stdout = sha(result.stdout.trim());
    if (command === "git" && args.includes("push") && result.code === 0) {
      const ref = args.at(-1)!.split(":").at(-1)!;
      fake.remoteHeads.set(ref, fake.workerHeads.get(args[1]!)!);
    }
    if (command === "git" && args.includes("rebase") && !args.includes("--abort")) {
      const current = fake.workerHeads.get(args[1]!);
      if (current) fake.ancestors.add(`${fake.projectHead}:${current}`);
    }
    if (
      command === "herdr" &&
      ((args[0] === "worktree" && args[1] === "open") ||
        (args[0] === "tab" && args[1] === "create")) &&
      result.code === 0
    ) {
      const value = JSON.parse(result.stdout).result;
      if (value.root_pane)
        panes.set(value.root_pane.pane_id, {
          cwd: args[args.indexOf(args[0] === "worktree" ? "--path" : "--cwd") + 1]!,
          workspaceId: value.workspace?.workspace_id ?? args[args.indexOf("--workspace") + 1]!,
          tabId: value.tab.tab_id,
        });
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
      const pane = panes.get(args[args.indexOf("--pane") + 1]!);
      if (pane) pane.name = args[2];
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "prompt" && result.code === 0) {
      const pane = panes.get(args[2]!);
      if (pane && fake.workerHeads.has(pane.cwd))
        fake.workerHeads.set(pane.cwd, `head-${args[2]!.slice("pane:".length)}`);
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "get" && result.code === 0) {
      const value = JSON.parse(result.stdout);
      const pane = panes.get(args[2]!);
      Object.assign(value.result.agent, {
        name: pane?.name,
        pane_id: args[2],
        cwd: pane?.cwd,
        workspace_id: pane?.workspaceId,
        tab_id: pane?.tabId,
        terminal_id: `terminal:${args[2]}`,
      });
      return ok(value);
    }
    return result;
  };
}

export const runtime: typeof baseRuntime = (root, fake, ...args) => {
  attachHerdr(fake, root);
  return baseRuntime(root, fake, ...args);
};
export const extensionRuntime: typeof baseExtensionRuntime = (root, fake, messages) => {
  attachHerdr(fake, root);
  return baseExtensionRuntime(root, fake, messages);
};
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
  const launched = (result.details as Array<Record<string, unknown>>)[0]!;
  return {
    root,
    project,
    fake,
    messages,
    instance,
    result,
    launched,
    reportPath: launched.report_path as string,
    reportSourcePath: launched.report_source_path as string,
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
