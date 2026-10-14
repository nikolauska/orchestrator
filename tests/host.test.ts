import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptLegacyLocalRecord,
  createHostRuntime,
  dispatchHostRequest,
  nativeExec,
  streamHostReport,
} from "../src/runtime/host";
import {
  canonicalPath,
  assertContained,
  HostFailure,
  nativeAbsolutePath,
  type PathRules,
} from "../src/runtime/host-paths";
import {
  PROTOCOL,
  ReportStreamValidator,
  releaseReceiptSchema,
  validateHostRequest,
  type AgentBinding,
  type HostArgs,
  type HostOp,
  type HostRequest,
  type HostResult,
  type ReportFrame,
  type ResultOp,
} from "../src/runtime/helper-protocol";
import { agentName, type ExecutionTarget } from "../src/runtime/execution";
import type { ExecResult, RuntimeDeps, WorkerRecord } from "../src/runtime/shared";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-host-"));
  temporaryRoots.push(root);
  const projects = join(root, "projects");
  const project = join(projects, "app ü space & % ! $ ; ' quote");
  const runtimeRoot = join(root, "runtime");
  const neutralRoot = join(root, "neutral");
  const leasesRoot = join(root, "leases");
  const overlayPath = join(root, "worker config.yml");
  await Promise.all(
    [project, runtimeRoot, neutralRoot, leasesRoot].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(overlayPath, "unattended: true\r\n");
  const gitPrefix = [
    "-c",
    "user.name=Host fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `core.hooksPath=${join(root, "no-hooks")}`,
  ];
  const git = async (cwd: string, args: string[]) => {
    const result = await nativeExec("git", [...gitPrefix, ...args], { cwd });
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git(project, ["init", "--initial-branch=main"]);
  await writeFile(join(project, "shared.txt"), "base\n");
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "base"]);
  const sourceHead = await git(project, ["rev-parse", "HEAD"]);
  const leases: Array<{ path: string; lease_id: string; lease_holder: string }> = [];
  const idleSlots: Array<{ path: string }> = [];
  const state = {
    lostAcquire: false,
    sourceAsLease: false,
    lostLand: false,
    lostPush: false,
    lostReturn: false,
    acquired: 0,
    returned: 0,
    integrationVersion: 10,
    statusFailure: "" as "" | "failed" | "timeout",
    failRebaseAbort: false,
  };
  const fixtureExec = async (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
  ): Promise<ExecResult> => {
    if (args[0] === "integration")
      return {
        code: 0,
        stderr: "",
        stdout: `omp: current (v${state.integrationVersion}) (configured host integration)`,
      };
    if (args[0] === "treehouse-fixture") {
      const operation = args[1];
      if (operation === "status") {
        if (state.statusFailure)
          return {
            code: 1,
            stderr: "temporary status failure",
            stdout: "",
            killed: state.statusFailure === "timeout",
          };
        return { code: 0, stderr: "", stdout: JSON.stringify([...leases, ...idleSlots]) };
      }
      if (operation === "get") {
        const holder = args[args.indexOf("--lease-holder") + 1]!;
        const path = state.sourceAsLease ? project : join(leasesRoot, `slot-${++state.acquired}`);
        if (!state.sourceAsLease) await git(project, ["worktree", "add", "--detach", path, "HEAD"]);
        const lease = { path, lease_id: randomUUID().replaceAll("-", ""), lease_holder: holder };
        leases.push(lease);
        if (state.lostAcquire) {
          state.lostAcquire = false;
          return { code: 1, stderr: "acknowledgement lost", stdout: "" };
        }
        return { code: 0, stderr: "", stdout: JSON.stringify(lease) };
      }
      if (operation === "return") {
        const id = args[args.indexOf("--if-lease-id") + 1];
        const holder = args[args.indexOf("--if-lease-holder") + 1];
        const index = leases.findIndex(
          (lease) => lease.lease_id === id && lease.lease_holder === holder,
        );
        if (index < 0) return { code: 1, stderr: "lease guard mismatch", stdout: "" };
        idleSlots.push({ path: leases[index]!.path });
        leases.splice(index, 1);
        state.returned++;
        if (state.lostReturn) {
          state.lostReturn = false;
          return { code: 1, stderr: "return acknowledgement lost", stdout: "" };
        }
        return { code: 0, stderr: "", stdout: "returned" };
      }
      if (args.includes("--help"))
        return {
          code: 0,
          stderr: "",
          stdout: "--lease-holder --json --if-lease-id --if-lease-holder",
        };
      return { code: 0, stderr: "", stdout: "Treehouse fixture 1" };
    }
    if (args[0] === "omp-fixture") {
      if (args.includes("models"))
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            models: [
              { kind: "chat", selector: "provider/model", thinking: ["high"], input: ["text"] },
            ],
          }),
        };
      if (args.includes("modelRoles"))
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ value: { default: "provider/model:high" } }),
        };
      if (args.includes("path"))
        return { code: 0, stderr: "", stdout: join(root, "sessions-parent") };
      return { code: 0, stderr: "", stdout: "OMP fixture 1" };
    }
    if (state.failRebaseAbort && args.includes("rebase") && args.includes("--abort"))
      return { code: 1, stderr: "abort failed before restoring worktree", stdout: "" };
    const result = await nativeExec(command, args, options);
    if ((state.lostLand && args.includes("merge")) || (state.lostPush && args.includes("push"))) {
      state.lostLand = false;
      state.lostPush = false;
      if (result.code === 0)
        return { code: 1, stderr: "acknowledgement lost after effect", stdout: "" };
    }
    return result;
  };
  const deps: RuntimeDeps = {
    exec: async (command, args, options) => {
      const result = await fixtureExec(command, args, options);
      return { ...result, killed: result.killed ?? false };
    },
    notify: () => {},
    logger: {} as RuntimeDeps["logger"],
  };
  const configuration = {
    version: 1 as const,
    hostId: randomUUID(),
    overlayPath,
    runtimeRoot,
    neutralRoot,
    queryCwd: project,
    approvedProjectRoots: [projects],
    executables: {
      git: { executable: Bun.which("git")!, prefixArgs: gitPrefix },
      treehouse: { executable: process.execPath, prefixArgs: ["treehouse-fixture"] },
      omp: { executable: process.execPath, prefixArgs: ["omp-fixture"] },
    },
  };
  const host = createHostRuntime(configuration, deps);
  const controllerId = randomUUID();
  const request = <Op extends HostOp>(
    op: Op,
    args: HostArgs[Op],
    operationId?: string,
  ): HostRequest<Op> =>
    validateHostRequest({
      protocol: PROTOCOL,
      version: 1,
      requestId: randomUUID(),
      controllerId,
      expectedHostId: configuration.hostId,
      op,
      args,
      ...(operationId ? { operationId } : {}),
    }) as HostRequest<Op>;
  const call = async <Op extends ResultOp>(
    op: Op,
    args: HostArgs[Op],
    operationId?: string,
  ): Promise<HostResult<Op>> => {
    const reply = await dispatchHostRequest(host, request(op, args, operationId));
    if (!reply.ok) throw new HostFailure(reply.error.code, reply.error.message, reply.error);
    return reply.result;
  };
  const allocate = async (kind: "implementation" | "scout" = "implementation") => {
    const launchId = randomUUID();
    const operationId = randomUUID();
    const resource = await call(
      "worker.allocate",
      { launchId, kind, scope: "project", projectPath: project, sourceHead, forbiddenRoots: [] },
      operationId,
    );
    return { launchId, operationId, resource };
  };
  const commit = async (cwd: string, file: string, text: string) => {
    await writeFile(join(cwd, file), text);
    await git(cwd, ["add", file]);
    await git(cwd, ["commit", "-m", file]);
    return git(cwd, ["rev-parse", "HEAD"]);
  };
  return {
    root,
    project,
    runtimeRoot,
    neutralRoot,
    overlayPath,
    sourceHead,
    controllerId,
    host,
    state,
    leases,
    git,
    request,
    call,
    allocate,
    commit,
  };
}

test.skipIf(process.platform === "win32")(
  "native timeout kills descendants holding inherited pipes",
  async () => {
    // This integration regression needs the real deadline and OS process/pipe lifecycle.
    const started = performance.now();
    const result = await nativeExec("sh", ["-c", "sleep 20 & sleep 60"], { timeout: 1_000 });
    expect(result.killed).toBe(true);
    expect(performance.now() - started).toBeLessThan(4_000);
  },
  5_000,
);

test.skipIf(process.platform === "win32")(
  "native abort kills descendants holding inherited pipes",
  async () => {
    const controller = new AbortController();
    const started = performance.now();
    const pending = nativeExec("sh", ["-c", "sleep 20 & sleep 60"], {
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.killed).toBe(true);
    expect(performance.now() - started).toBeLessThan(3_000);
  },
  4_000,
);

test("preflight exposes the actual host integration version and rejects old/missing host tools", async () => {
  const f = await fixture();
  f.host.discoverExecutable = (name) => (name === "herdr" ? process.execPath : Bun.which(name));
  const requiredOverlaySha256 = createHash("sha256")
    .update(await readFile(f.overlayPath))
    .digest("hex");
  const result = await f.call("preflight", { scope: "independent", requiredOverlaySha256 });
  expect(result.tools.find((tool) => tool.name === "herdr-omp-integration")).toMatchObject({
    available: true,
    version: "10",
  });
  f.state.integrationVersion = 2;
  await expect(
    f.call("preflight", { scope: "independent", requiredOverlaySha256 }),
  ).rejects.toMatchObject({
    detail: { code: "CAPABILITY_MISSING", remedy: expect.stringContaining("Manually") },
  });
  f.host.configuration.executables.omp.executable = join(f.root, "missing-native-executable");
  await expect(
    f.call("preflight", { scope: "independent", requiredOverlaySha256 }),
  ).rejects.toMatchObject({ detail: { code: "PREREQUISITE_MISSING" } });
});

test("session reads require the exact worker binding and survive absent response text", async () => {
  const f = await fixture();
  const launchId = randomUUID();
  const resource = await f.call(
    "worker.allocate",
    { launchId, scope: "independent", kind: "scout", forbiddenRoots: [] },
    randomUUID(),
  );
  const sessions = join(f.root, "sessions-parent", "sessions");
  await mkdir(sessions, { recursive: true });
  f.host.sessionRoots = [sessions];
  const sessionPath = join(sessions, "owned.jsonl");
  const other = join(sessions, "other.jsonl");
  await writeFile(
    sessionPath,
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Final evidence" }] },
    }) + "\n",
  );
  await writeFile(
    other,
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Unrelated conversation" }] },
    }) + "\n",
  );
  const binding: AgentBinding = {
    revision: 1,
    identity: "omp",
    agentName: agentName(f.controllerId, launchId),
    session: "bound-session",
    workspaceId: "w",
    tabId: "t",
    paneId: "p",
    cwd: resource.directory,
    sessionPath,
  };
  await f.call("worker.bind-agent", { launchId, binding }, randomUUID());
  expect(await f.call("session.last-response", { launchId, sessionPath })).toEqual({
    text: "Final evidence",
  });
  await expect(
    f.call("session.last-response", { launchId, sessionPath: other }),
  ).rejects.toMatchObject({ detail: { code: "AGENT_MISMATCH" } });
  await expect(
    f.call(
      "worker.bind-agent",
      { launchId, binding: { ...binding, revision: 2, session: "different" } },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ detail: { code: "AGENT_MISMATCH" } });
  await rm(sessionPath);
  expect(await f.call("session.last-response", { launchId, sessionPath })).toEqual({
    unavailableReason: "Bound OMP session file is unavailable.",
  });
});

describe("host ownership and delivery", () => {
  test("reconciliation retires pre-effect interruptions only while holding the ledger lock", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    if (resource.scope !== "project") throw new Error("expected project resource");
    const operationId = randomUUID();
    const args = {
      launchId,
      leaseId: resource.lease.leaseId,
      leaseHolder: resource.lease.leaseHolder,
      proof: "discard" as const,
      herdrClosed: true as const,
    };
    f.state.statusFailure = "failed";
    await expect(f.call("worker.release", args, operationId)).rejects.toThrow();
    const ledgerPath = join(f.runtimeRoot, "controllers", f.controllerId, "ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.operations[operationId].view.state = "running";
    await writeFile(ledgerPath, JSON.stringify(ledger));
    const lock = join(f.runtimeRoot, "controllers", f.controllerId, "mutation.lock");
    await mkdir(lock);
    expect((await f.call("operation.get", { operationId })).state).toBe("uncertain");
    await rm(lock, { recursive: true });
    expect(await f.call("operation.get", { operationId })).toMatchObject({
      state: "refused",
      error: { code: "COMMAND_FAILED", effect: "none" },
    });
    f.state.statusFailure = "";
    await f.call("worker.release", args, randomUUID());
    expect(f.state.returned).toBe(1);
  });

  test("missing push origin refuses before publication and a fresh operation can publish", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    const head = await f.commit(resource.directory.path, "worker.txt", "publication\n");
    const operationId = randomUUID();
    const args = { launchId, pushTo: "explicit", expectedWorkerHead: head };
    await expect(f.call("delivery.push", args, operationId)).rejects.toMatchObject({
      detail: { code: "COMMAND_FAILED", effect: "none" },
    });
    expect((await f.call("delivery.lookup", { launchId, operationId })).operation.state).toBe(
      "refused",
    );
    const origin = join(f.root, "origin.git");
    await f.git(f.root, ["init", "--bare", origin]);
    await f.git(resource.directory.path, ["remote", "add", "origin", origin]);
    expect((await f.call("delivery.push", args, randomUUID())).kind).toBe("pushed");
    expect(await f.git(origin, ["rev-parse", "refs/heads/explicit"])).toBe(head);
  });

  test.each(["failed", "timeout"] as const)(
    "pre-effect release %s is refused and a fresh operation succeeds",
    async (failure) => {
      const f = await fixture();
      const { resource, launchId } = await f.allocate();
      if (resource.scope !== "project") throw new Error("expected project resource");
      const operationId = randomUUID();
      const args = {
        launchId,
        leaseId: resource.lease.leaseId,
        leaseHolder: resource.lease.leaseHolder,
        proof: "discard" as const,
        herdrClosed: true as const,
      };
      f.state.statusFailure = failure;
      const code = failure === "timeout" ? "TIMEOUT" : "COMMAND_FAILED";
      await expect(f.call("worker.release", args, operationId)).rejects.toMatchObject({
        detail: { code, effect: "none", retry: "user_action" },
      });
      expect(await f.call("operation.get", { operationId })).toMatchObject({
        state: "refused",
        error: { code, effect: "none" },
      });
      expect(f.state.returned).toBe(0);
      f.state.statusFailure = "";
      await f.call("worker.release", args, randomUUID());
      expect(f.state.returned).toBe(1);
    },
  );

  test("pre-effect allocation and read-only inspection timeouts have no effect", async () => {
    const f = await fixture();
    const launchId = randomUUID();
    const operationId = randomUUID();
    const args = {
      launchId,
      kind: "implementation" as const,
      scope: "project" as const,
      projectPath: f.project,
      sourceHead: f.sourceHead,
      forbiddenRoots: [],
    };
    f.state.statusFailure = "timeout";
    await expect(f.call("worker.allocate", args, operationId)).rejects.toMatchObject({
      detail: { code: "TIMEOUT", effect: "none" },
    });
    expect((await f.call("operation.get", { operationId })).state).toBe("refused");
    expect(f.state.acquired).toBe(0);
    f.state.statusFailure = "";
    await f.call("worker.allocate", args, randomUUID());
    f.state.statusFailure = "timeout";
    await expect(f.call("worker.inspect", { launchId })).rejects.toMatchObject({
      detail: { code: "TIMEOUT", effect: "none" },
    });
    expect(f.state.acquired).toBe(1);
  });

  test("held project lock refuses delivery without effects and a fresh operation can land", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    if (resource.scope !== "project") throw new Error("expected project resource");
    const head = await f.commit(resource.directory.path, "worker.txt", "delivery\n");
    const operationId = randomUUID();
    const args = {
      launchId,
      expectedBranch: "main",
      deliveryBase: f.sourceHead,
      expectedWorkerHead: head,
    };
    const lock = join(
      f.runtimeRoot,
      "project-locks",
      createHash("sha256").update(resource.project.pathKey).digest("hex"),
    );
    await mkdir(lock, { recursive: true });
    await expect(f.call("delivery.land", args, operationId)).rejects.toMatchObject({
      detail: { code: "LOCK_BUSY", effect: "none" },
    });
    expect((await f.call("delivery.lookup", { launchId, operationId })).operation).toMatchObject({
      state: "refused",
      error: { code: "LOCK_BUSY", effect: "none" },
    });
    expect(await f.git(f.project, ["rev-parse", "HEAD"])).toBe(f.sourceHead);
    await rm(lock, { recursive: true });
    const receipt = await f.call("delivery.land", args, randomUUID());
    expect(receipt.kind).toBe("merged");
    expect(await f.git(f.project, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("missing forbidden roots outside approved projects validate and permit allocation", async () => {
    const f = await fixture();
    const missing = join(f.root, "removed-controller", "nested");
    const forbidden = await f.call("path.validate", { path: missing, kind: "forbidden_root" });
    expect(forbidden).toEqual({ path: await canonicalPath(missing, { allowMissing: true }) });
    const resource = await f.call(
      "worker.allocate",
      {
        launchId: randomUUID(),
        kind: "implementation",
        scope: "project",
        projectPath: f.project,
        sourceHead: f.sourceHead,
        forbiddenRoots: [forbidden.path],
      },
      randomUUID(),
    );
    expect(resource.scope).toBe("project");
    expect(f.state.acquired).toBe(1);
    await expect(access(missing)).rejects.toThrow();
  });

  test("a moved publication absent locally refuses release without fetching or uncertainty", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    if (resource.scope !== "project") throw new Error("expected project resource");
    const head = await f.commit(resource.directory.path, "worker.txt", "publication\n");
    const origin = join(f.root, "origin.git");
    await f.git(f.root, ["init", "--bare", origin]);
    await f.git(resource.directory.path, ["remote", "add", "origin", origin]);
    const receipt = await f.call(
      "delivery.push",
      {
        launchId,
        pushTo: "explicit",
        expectedWorkerHead: head,
      },
      randomUUID(),
    );
    const foreign = join(f.root, "foreign");
    await f.git(f.root, ["clone", "--branch", "explicit", origin, foreign]);
    const remoteHead = await f.commit(foreign, "foreign.txt", "foreign\n");
    await f.git(foreign, ["push", "origin", "explicit"]);
    const operationId = randomUUID();
    const args = {
      launchId,
      leaseId: resource.lease.leaseId,
      leaseHolder: resource.lease.leaseHolder,
      proof: "settled" as const,
      receiptId: receipt.id,
      herdrClosed: true as const,
    };
    await expect(f.call("worker.release", args, operationId)).rejects.toMatchObject({
      detail: { code: "TARGET_DIRTY", effect: "none" },
    });
    expect((await f.call("operation.get", { operationId })).state).toBe("refused");
    expect(f.state.returned).toBe(0);
    const object = await nativeExec("git", [
      "-C",
      resource.directory.path,
      "cat-file",
      "-e",
      `${remoteHead}^{commit}`,
    ]);
    expect(object.code).not.toBe(0);
    await f.call("worker.release", { ...args, proof: "discard" }, randomUUID());
    expect(f.state.returned).toBe(1);
  });

  test("pre-ledger lock refusal has no effect; missing IDs are fenced before safe recovery", async () => {
    const f = await fixture();
    const launchId = randomUUID();
    const operationId = randomUUID();
    const args = {
      launchId,
      kind: "implementation" as const,
      scope: "project" as const,
      projectPath: f.project,
      sourceHead: f.sourceHead,
      forbiddenRoots: [],
    };
    const lock = join(f.runtimeRoot, "controllers", f.controllerId, "mutation.lock");
    await mkdir(lock, { recursive: true });
    await expect(f.call("worker.allocate", args, operationId)).rejects.toMatchObject({
      detail: { code: "LOCK_BUSY", effect: "none" },
    });
    expect(f.state.acquired).toBe(0);
    expect(await f.call("worker.lookup", { launchId })).toEqual({ launchId, operations: [] });
    await expect(f.call("operation.get", { operationId })).rejects.toMatchObject({
      detail: { code: "OPERATION_UNCERTAIN", effect: "unknown" },
    });
    await rm(lock, { recursive: true });
    await expect(f.call("operation.get", { operationId })).rejects.toMatchObject({
      detail: { code: "OPERATION_NOT_STARTED", effect: "none" },
    });
    await expect(f.call("worker.allocate", args, operationId)).rejects.toMatchObject({
      detail: { code: "OPERATION_NOT_STARTED", effect: "none" },
    });
    await f.call("worker.allocate", args, randomUUID());
    expect(f.state.acquired).toBe(1);
  });

  test("concurrent allocation and reconciliation serialize without refusing mutations", async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([f.allocate("scout"), f.allocate()]);
    const [one, two] = await Promise.all([
      f.call("worker.lookup", { launchId: first.launchId }),
      f.call("worker.lookup", { launchId: second.launchId }),
    ]);
    expect(one.resource?.directory).toEqual(first.resource.directory);
    expect(two.resource?.directory).toEqual(second.resource.directory);
    expect(one.operations[0]?.state).toBe("confirmed");
    expect(two.operations[0]?.state).toBe("confirmed");
    expect(f.state.acquired).toBe(2);
  });

  test("lock refusal does not erase uncertainty for an operation already in the ledger", async () => {
    const f = await fixture();
    f.state.lostAcquire = true;
    const launchId = randomUUID();
    const operationId = randomUUID();
    const args = {
      launchId,
      kind: "implementation" as const,
      scope: "project" as const,
      projectPath: f.project,
      sourceHead: f.sourceHead,
      forbiddenRoots: [],
    };
    await expect(f.call("worker.allocate", args, operationId)).rejects.toMatchObject({
      detail: { effect: "unknown" },
    });
    const lock = join(f.runtimeRoot, "controllers", f.controllerId, "mutation.lock");
    await mkdir(lock);
    await expect(f.call("worker.allocate", args, operationId)).rejects.toMatchObject({
      detail: { effect: "unknown" },
    });
    expect(f.state.acquired).toBe(1);
  });

  test("allocates exact captured SHA and excludes source dirty files without resetting source", async () => {
    const f = await fixture();
    const advanced = await f.commit(f.project, "later.txt", "later\n");
    await writeFile(join(f.project, "shared.txt"), "dirty source\n");
    await writeFile(join(f.project, "untracked.txt"), "private\n");
    const snapshot = await f.call("project.snapshot", {
      projectPath: f.project,
      tasks: [{ name: "scout", kind: "scout" }],
    });
    expect(snapshot.head).toBe(advanced);
    expect(snapshot.excludedChanges).toContain("shared.txt");
    const { resource } = await f.allocate("scout");
    expect(await f.git(resource.directory.path, ["rev-parse", "HEAD"])).toBe(f.sourceHead);
    expect(await readFile(join(resource.directory.path, "shared.txt"), "utf8")).toBe("base\n");
    await expect(access(join(resource.directory.path, "later.txt"))).rejects.toThrow();
    await expect(access(join(resource.directory.path, "untracked.txt"))).rejects.toThrow();
    expect(await f.git(f.project, ["rev-parse", "HEAD"])).toBe(advanced);
    expect(await readFile(join(f.project, "shared.txt"), "utf8")).toBe("dirty source\n");
  });

  test("rebases moved target, fast-forwards only that checkout and replays only a durable receipt", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    const oldWorkerHead = await f.commit(resource.directory.path, "worker.txt", "worker\n");
    const movedTarget = await f.commit(f.project, "target.txt", "target\n");
    const operationId = randomUUID();
    const args = {
      launchId,
      expectedBranch: "main",
      deliveryBase: f.sourceHead,
      expectedWorkerHead: oldWorkerHead,
    };
    const receipt = await f.call("delivery.land", args, operationId);
    expect(receipt.kind).toBe("merged");
    expect(receipt.deliveryBase).toBe(movedTarget);
    expect(receipt.workerHead).not.toBe(oldWorkerHead);
    expect(await f.git(f.project, ["rev-parse", "HEAD"])).toBe(receipt.workerHead);
    expect(await f.git(f.project, ["merge-base", movedTarget, receipt.workerHead])).toBe(
      movedTarget,
    );
    expect(await readFile(join(f.project, "worker.txt"), "utf8")).toBe("worker\n");
    expect(await readFile(join(f.project, "target.txt"), "utf8")).toBe("target\n");
    const restarted = createHostRuntime(f.host.configuration, f.host.deps);
    const repeated = await dispatchHostRequest(
      restarted,
      f.request("delivery.land", args, operationId),
    );
    expect(repeated.ok && repeated.result).toEqual(receipt);
    expect(await f.git(f.project, ["rev-list", "--count", "HEAD"])).toBe("3");
    const lease = resource.scope === "project" ? resource.lease : undefined;
    const release = await f.call(
      "worker.release",
      {
        launchId,
        leaseId: lease!.leaseId,
        leaseHolder: lease!.leaseHolder,
        proof: "settled",
        receiptId: receipt.id,
        herdrClosed: true,
      },
      randomUUID(),
    );
    expect(release.path).toEqual(resource.directory);
    expect(f.leases).toEqual([]);
  });

  test("retains rebase conflict and dirty/changed delivery targets", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    const workerHead = await f.commit(resource.directory.path, "shared.txt", "worker conflict\n");
    const target = await f.commit(f.project, "shared.txt", "target conflict\n");
    const args = {
      launchId,
      expectedBranch: "main",
      deliveryBase: f.sourceHead,
      expectedWorkerHead: workerHead,
    };
    const operationId = randomUUID();
    await expect(f.call("delivery.land", args, operationId)).rejects.toMatchObject({
      detail: { code: "REBASE_CONFLICT", effect: "none" },
    });
    expect((await f.call("delivery.lookup", { launchId, operationId })).operation).toMatchObject({
      state: "refused",
      error: { code: "REBASE_CONFLICT", effect: "none" },
    });
    expect(await f.git(resource.directory.path, ["rev-parse", "HEAD"])).toBe(workerHead);
    expect(await f.git(f.project, ["rev-parse", "HEAD"])).toBe(target);
    await writeFile(join(f.project, "shared.txt"), "dirty\n");
    await expect(f.call("delivery.land", args, randomUUID())).rejects.toMatchObject({
      detail: { code: "TARGET_DIRTY" },
    });
    expect(await readFile(join(f.project, "shared.txt"), "utf8")).toBe("dirty\n");
    await f.git(f.project, ["restore", "shared.txt"]);
    await f.git(f.project, ["checkout", "-b", "different"]);
    await expect(f.call("delivery.land", args, randomUUID())).rejects.toMatchObject({
      detail: { code: "BRANCH_CHANGED" },
    });
    expect(f.leases.length).toBe(1);
  });

  test("failed conflict rollback retains rebase uncertainty and never replays delivery", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    const workerHead = await f.commit(resource.directory.path, "shared.txt", "worker conflict\n");
    const target = await f.commit(f.project, "shared.txt", "target conflict\n");
    const args = {
      launchId,
      expectedBranch: "main",
      deliveryBase: f.sourceHead,
      expectedWorkerHead: workerHead,
    };
    const operationId = randomUUID();
    f.state.failRebaseAbort = true;
    await expect(f.call("delivery.land", args, operationId)).rejects.toMatchObject({
      detail: { code: "REBASE_CONFLICT", effect: "unknown" },
    });
    const lookup = await f.call("delivery.lookup", { launchId, operationId });
    expect(lookup.operation).toMatchObject({
      state: "uncertain",
      checkpoint: { deliveryBase: target },
      error: { effect: "unknown" },
    });
    const conflicted = await readFile(join(resource.directory.path, "shared.txt"), "utf8");
    expect(conflicted).toContain("<<<<<<<");
    await expect(f.call("delivery.land", args, operationId)).rejects.toMatchObject({
      detail: { code: "OPERATION_UNCERTAIN", effect: "unknown" },
    });
    expect(await readFile(join(resource.directory.path, "shared.txt"), "utf8")).toBe(conflicted);
    expect(await f.git(f.project, ["rev-parse", "HEAD"])).toBe(target);
    expect(f.leases.length).toBe(1);
  });

  test("reconciles lost lease acknowledgement without acquiring or resetting again", async () => {
    const f = await fixture();
    f.state.lostAcquire = true;
    const launchId = randomUUID(),
      operationId = randomUUID();
    const args = {
      launchId,
      kind: "implementation" as const,
      scope: "project" as const,
      projectPath: f.project,
      sourceHead: f.sourceHead,
      forbiddenRoots: [],
    };
    await expect(f.call("worker.allocate", args, operationId)).rejects.toMatchObject({
      detail: { effect: "unknown" },
    });
    const worktree = f.leases[0]!.path;
    await writeFile(join(worktree, "shared.txt"), "retained evidence\n");
    const lookup = await f.call("worker.lookup", { launchId });
    expect(lookup.resource?.directory.path).toBe(worktree);
    expect(lookup.operations[0]?.state).toBe("uncertain");
    await expect(f.call("worker.allocate", args, operationId)).rejects.toMatchObject({
      detail: { code: "OPERATION_UNCERTAIN" },
    });
    await expect(f.call("worker.allocate", args, randomUUID())).rejects.toMatchObject({
      detail: { code: "OPERATION_UNCERTAIN" },
    });
    expect(f.state.acquired).toBe(1);
    expect(f.leases.length).toBe(1);
    expect(await readFile(join(worktree, "shared.txt"), "utf8")).toBe("retained evidence\n");
    await expect(
      f.call("worker.allocate", { ...args, sourceHead: "a".repeat(40) }, operationId),
    ).rejects.toMatchObject({ detail: { code: "INVALID_REQUEST" } });
  });

  test("refuses source-root alias returned as a lease before reset", async () => {
    const f = await fixture();
    f.state.sourceAsLease = true;
    await writeFile(join(f.project, "shared.txt"), "source must survive\n");
    await expect(f.allocate()).rejects.toMatchObject({ detail: { code: "LEASE_MISMATCH" } });
    expect(await readFile(join(f.project, "shared.txt"), "utf8")).toBe("source must survive\n");
    expect(await f.git(f.project, ["rev-parse", "HEAD"])).toBe(f.sourceHead);
  });

  test("recovers successful land and explicit push whose command acknowledgements were lost", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    const head = await f.commit(resource.directory.path, "worker.txt", "delivery\n");
    const operationId = randomUUID();
    f.state.lostLand = true;
    await expect(
      f.call(
        "delivery.land",
        { launchId, expectedBranch: "main", deliveryBase: f.sourceHead, expectedWorkerHead: head },
        operationId,
      ),
    ).rejects.toMatchObject({ detail: { effect: "unknown" } });
    const lookup = await f.call("delivery.lookup", { launchId, operationId });
    expect(lookup.operation.state).toBe("confirmed");
    expect(lookup.receipt?.workerHead).toBe(head);
    expect(await f.git(f.project, ["rev-parse", "HEAD"])).toBe(head);
    const origin = join(f.root, "origin.git");
    await f.git(f.root, ["init", "--bare", origin]);
    await f.git(resource.directory.path, ["remote", "add", "origin", origin]);
    f.state.lostPush = true;
    const pushOperation = randomUUID();
    await expect(
      f.call(
        "delivery.push",
        { launchId, pushTo: "explicit", expectedWorkerHead: head },
        pushOperation,
      ),
    ).rejects.toMatchObject({ detail: { effect: "unknown" } });
    const pushed = await f.call("delivery.lookup", { launchId, operationId: pushOperation });
    expect(pushed.receipt?.kind).toBe("pushed");
    expect(await f.git(origin, ["rev-parse", "refs/heads/explicit"])).toBe(head);
  });

  test("lost guarded-return acknowledgement reconciles without returning another lease", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate();
    if (resource.scope !== "project") throw new Error("expected project resource");
    const operationId = randomUUID();
    const args = {
      launchId,
      leaseId: resource.lease.leaseId,
      leaseHolder: resource.lease.leaseHolder,
      proof: "discard" as const,
      herdrClosed: true as const,
    };
    f.state.lostReturn = true;
    await expect(f.call("worker.release", args, operationId)).rejects.toMatchObject({
      detail: { effect: "unknown" },
    });
    const reconciled = await f.call("operation.get", { operationId });
    expect(reconciled.state).toBe("confirmed");
    const repeated = await f.call("worker.release", args, operationId);
    expect(repeated).toEqual(releaseReceiptSchema.parse(reconciled.result));
    expect(f.state.returned).toBe(1);
    expect(f.leases).toEqual([]);
  });
});

describe("report and cleanup ownership", () => {
  test("failed staged-report removal can be retried with a fresh forget operation", async () => {
    const f = await fixture();
    const { resource, launchId } = await f.allocate("scout");
    if (resource.scope !== "project") throw new Error("expected project resource");
    const released = await f.call(
      "worker.release",
      {
        launchId,
        leaseId: resource.lease.leaseId,
        leaseHolder: resource.lease.leaseHolder,
        proof: "discard",
        herdrClosed: true,
      },
      randomUUID(),
    );
    await mkdir(resource.reportSourcePath!);
    const operationId = randomUUID();
    const args = { launchId, cleanupReceiptId: released.id };
    await expect(f.call("worker.forget", args, operationId)).rejects.toMatchObject({
      detail: { code: "COMMAND_FAILED", effect: "none" },
    });
    expect((await f.call("operation.get", { operationId })).state).toBe("refused");
    await rm(resource.reportSourcePath!, { recursive: true });
    expect(await f.call("worker.forget", args, randomUUID())).toEqual({
      launchId,
      forgotten: true,
    });
  });

  test("collects exact CRLF/Unicode bytes and gates release/forget on acknowledged report", async () => {
    const f = await fixture();
    const { launchId, resource } = await f.allocate("scout");
    const content = Buffer.from("# Evidence ü\r\n" + "Large 😀 report\r\n".repeat(9000));
    await writeFile(resource.reportSourcePath!, content);
    const request = f.request("report.read", { launchId });
    const validator = new ReportStreamValidator(request);
    const chunks: Buffer[] = [];
    let final: Extract<ReportFrame, { type: "end" }> | undefined;
    for await (const frame of streamHostReport(f.host, request)) {
      validator.accept(frame);
      if (frame.type === "chunk") chunks.push(Buffer.from(frame.bytesBase64, "base64"));
      if (frame.type === "end") final = frame;
    }
    validator.finish();
    expect(Buffer.concat(chunks)).toEqual(content);
    expect(final!.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    const lease = resource.scope === "project" ? resource.lease : undefined;
    const releaseArgs = {
      launchId,
      leaseId: lease!.leaseId,
      leaseHolder: lease!.leaseHolder,
      proof: "closed" as const,
      herdrClosed: true as const,
    };
    await expect(f.call("worker.release", releaseArgs, randomUUID())).rejects.toMatchObject({
      detail: { code: "REPORT_INVALID" },
    });
    expect(f.state.returned).toBe(0);
    const receipt = {
      id: randomUUID(),
      operationId: randomUUID(),
      launchId,
      localPath: join(f.root, "archive.md"),
      provenancePath: join(f.root, "archive.meta.json"),
      byteCount: content.length,
      sha256: final!.sha256,
      collectedAt: new Date().toISOString(),
    };
    await writeFile(receipt.localPath, content);
    await expect(
      f.call(
        "report.ack",
        { launchId, receipt: { ...receipt, sha256: "0".repeat(64) } },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ detail: { code: "REPORT_CHANGED" } });
    await f.call("report.ack", { launchId, receipt }, randomUUID());
    await writeFile(resource.reportSourcePath!, "changed after acknowledgement\n");
    await expect(
      f.call("worker.release", { ...releaseArgs, receiptId: receipt.id }, randomUUID()),
    ).rejects.toMatchObject({ detail: { code: "REPORT_CHANGED" } });
    expect(f.state.returned).toBe(0);
    await writeFile(resource.reportSourcePath!, content);
    const releaseId = randomUUID();
    const released = await f.call(
      "worker.release",
      { ...releaseArgs, receiptId: receipt.id },
      releaseId,
    );
    const again = await f.call(
      "worker.release",
      { ...releaseArgs, receiptId: receipt.id },
      releaseId,
    );
    expect(again).toEqual(released);
    expect(f.state.returned).toBe(1);
    // A prior forget attempt can delete the report before its ledger result is durable.
    await rm(resource.reportSourcePath!);
    await f.call("worker.forget", { launchId, cleanupReceiptId: released.id }, randomUUID());
    await expect(access(resource.reportSourcePath!)).rejects.toThrow();
    expect(await readFile(receipt.localPath)).toEqual(content);
  });

  test("rejects redirected, invalid UTF-8, whitespace and changing reports", async () => {
    const f = await fixture();
    const { launchId, resource } = await f.allocate("scout");
    const path = resource.reportSourcePath!;
    const collect = async () => {
      for await (const _frame of streamHostReport(f.host, f.request("report.read", { launchId }))) {
        /* Consume to validate the complete export, not only its begin frame. */
      }
    };
    await writeFile(path, " \r\n\t");
    await expect(collect()).rejects.toMatchObject({ detail: { code: "REPORT_INVALID" } });
    await writeFile(
      path,
      Buffer.concat([Buffer.from("valid\n".repeat(20_000)), Buffer.from([0xff])]),
    );
    await expect(collect()).rejects.toMatchObject({ detail: { code: "REPORT_INVALID" } });
    await rm(path);
    const other = join(f.root, "private.md");
    await writeFile(other, "private\n");
    await symlink(other, path);
    await expect(collect()).rejects.toMatchObject({
      detail: { code: expect.stringMatching(/PATH_FORBIDDEN|REPORT_INVALID/) },
    });
    await rm(path);
    await writeFile(path, "report\n".repeat(20_000));
    const iterator = streamHostReport(f.host, f.request("report.read", { launchId }));
    await iterator.next();
    await writeFile(path, "changed\n");
    await expect(
      (async () => {
        for await (const _frame of iterator) {
        }
      })(),
    ).rejects.toMatchObject({ detail: { code: "REPORT_CHANGED" } });
    expect(await readFile(path, "utf8")).toBe("changed\n");
  });

  test("neutral cleanup unlinks nested redirects without deleting their targets", async () => {
    const f = await fixture();
    const launchId = randomUUID();
    const resource = await f.call(
      "worker.allocate",
      { launchId, scope: "independent", kind: "scout", forbiddenRoots: [] },
      randomUUID(),
    );
    const target = join(f.root, "keep");
    await mkdir(target);
    await writeFile(join(target, "evidence.txt"), "keep\n");
    await symlink(
      target,
      join(resource.directory.path, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await f.call("worker.release", { launchId, proof: "discard", herdrClosed: true }, randomUUID());
    await expect(access(resource.directory.path)).rejects.toThrow();
    expect(await readFile(join(target, "evidence.txt"), "utf8")).toBe("keep\n");
  });

  test("legacy adoption preserves old lease, dirty work, unknown source and archive ownership", async () => {
    const f = await fixture();
    const { launchId, resource } = await f.allocate("scout");
    const legacyController = randomUUID();
    f.leases[0]!.lease_holder = "omp-orchestrator:legacy-name";
    const archive = join(f.root, "legacy-archive.md");
    await writeFile(archive, "legacy report\n");
    await writeFile(join(resource.directory.path, "shared.txt"), "legacy dirty evidence\n");
    const target: ExecutionTarget = {
      kind: "local",
      machineId: "local",
      hostId: f.host.configuration.hostId,
      os: process.platform as "linux" | "darwin" | "win32",
      arch: process.arch,
      pathStyle: process.platform === "win32" ? "win32" : "posix",
      session: "original",
      workerConfig: {
        path: f.overlayPath,
        sha256: createHash("sha256")
          .update(await readFile(f.overlayPath))
          .digest("hex"),
      },
      runtimeRoot: await canonicalPath(f.runtimeRoot),
      neutralRoot: await canonicalPath(f.neutralRoot),
    };
    const binding: AgentBinding = {
      revision: 1,
      identity: "omp",
      agentName: "legacy-name",
      session: "original",
      workspaceId: "w",
      tabId: "t",
      paneId: "p",
      cwd: resource.directory,
    };
    const record: WorkerRecord = {
      scope: "project",
      kind: "scout",
      name: "legacy-name",
      status: "working",
      generation: 0,
      controller_id: legacyController,
      launch_id: launchId,
      target: { kind: "unresolved_local", machineId: "local" },
      projectPath: f.project,
      worktree: resource.directory.path,
      lease_id: f.leases[0]!.lease_id,
      lease_holder: f.leases[0]!.lease_holder,
      workspace_id: "w",
      tab_id: "t",
      pane_id: "p",
      report_path: archive,
    };
    const local = createHostRuntime(f.host.configuration, f.host.deps, { local: true });
    const adopted = await adoptLegacyLocalRecord(local, record, target, binding);
    expect(adopted.scope === "project" && adopted.sourceHead).toBeUndefined();
    expect(adopted.scope === "project" && adopted.lease.leaseHolder).toBe(
      "omp-orchestrator:legacy-name",
    );
    expect(await readFile(join(resource.directory.path, "shared.txt"), "utf8")).toBe(
      "legacy dirty evidence\n",
    );
    expect(f.state.acquired).toBe(1);
    const req = <Op extends HostOp>(op: Op, args: HostArgs[Op], operationId?: string) => ({
      ...f.request(op, args, operationId),
      controllerId: legacyController,
    });
    const released = await dispatchHostRequest(
      local,
      req(
        "worker.release",
        {
          launchId,
          proof: "discard",
          herdrClosed: true,
          leaseId: record.lease_id,
          leaseHolder: record.lease_holder,
        },
        randomUUID(),
      ),
    );
    if (!released.ok) throw new Error(released.error.message);
    await dispatchHostRequest(
      local,
      req("worker.forget", { launchId, cleanupReceiptId: released.result.id }, randomUUID()),
    );
    expect(await readFile(archive, "utf8")).toBe("legacy report\n");
    await expect(adoptLegacyLocalRecord(f.host, record, target, binding)).rejects.toMatchObject({
      detail: { code: "INVALID_REQUEST" },
    });
  });
});

describe("native host paths", () => {
  test("Windows rejects drive-relative/ambiguous/device paths and resolves host home", () => {
    const options: PathRules = { os: "win32", home: "D:\\Users\\Nïko" };
    for (const path of [
      "C:repo",
      "\\repo",
      "/repo",
      "relative",
      "\\\\.\\pipe\\x",
      "C:\\src\\CON",
      "C:\\app:secret",
      "C:\\repo.\\app",
    ])
      expect(() => nativeAbsolutePath(path, options)).toThrow(HostFailure);
    expect(nativeAbsolutePath("~/source ü/app", options)).toBe("D:\\Users\\Nïko\\source ü\\app");
    expect(nativeAbsolutePath("\\\\server\\share\\repo", options)).toBe("\\\\server\\share\\repo");
  });

  test("Windows identity collapses aliases/case-insensitive paths, not distinct case-sensitive directories", async () => {
    const entries: Record<string, { path: string; key: string }> = {
      "C:\\": { path: "C:\\", key: "drive" },
      "C:\\src": { path: "C:\\src", key: "src" },
      "C:\\src\\App": { path: "C:\\src\\App", key: "app" },
      "c:\\SRC\\app": { path: "C:\\src\\App", key: "app" },
      "C:\\alias": { path: "C:\\src\\App", key: "app" },
      "C:\\src\\Case": { path: "C:\\src\\Case", key: "case-upper" },
      "C:\\src\\case": { path: "C:\\src\\case", key: "case-lower" },
      "D:\\outside": { path: "D:\\outside", key: "outside" },
      "D:\\": { path: "D:\\", key: "other-drive" },
      "C:\\src\\escape": { path: "D:\\outside", key: "outside" },
    };
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    const options: PathRules = {
      os: "win32",
      realpath: async (path) => {
        const entry = entries[path];
        if (!entry) throw missing();
        return entry.path;
      },
      identity: async (path) => {
        const entry = entries[path];
        if (!entry) throw missing();
        return entry.key;
      },
    };
    const original = await canonicalPath("C:/src/App", options);
    expect((await canonicalPath("c:/SRC/app", options)).pathKey).toBe(original.pathKey);
    expect((await canonicalPath("C:/alias", options)).pathKey).toBe(original.pathKey);
    expect((await canonicalPath("C:/src/Case", options)).pathKey).not.toBe(
      (await canonicalPath("C:/src/case", options)).pathKey,
    );
    await expect(assertContained("C:/src", "C:/src/escape", options)).rejects.toMatchObject({
      detail: { code: "PATH_FORBIDDEN" },
    });
    await expect(assertContained("C:/src", "D:/outside", options)).rejects.toMatchObject({
      detail: { code: "PATH_FORBIDDEN" },
    });
  });

  test("real symlink aliases compare equal and containment rejects escaped existing/missing paths", async () => {
    const f = await fixture();
    const alias = join(f.root, "alias");
    await symlink(f.project, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await canonicalPath(alias)).pathKey).toBe((await canonicalPath(f.project)).pathKey);
    const escape = join(f.project, "escape");
    await symlink(f.neutralRoot, escape, process.platform === "win32" ? "junction" : "dir");
    await expect(assertContained(f.project, escape)).rejects.toMatchObject({
      detail: { code: "PATH_FORBIDDEN" },
    });
    await expect(
      assertContained(f.project, join(escape, "missing"), { allowMissing: true }),
    ).rejects.toMatchObject({ detail: { code: "PATH_FORBIDDEN" } });
  });
});
