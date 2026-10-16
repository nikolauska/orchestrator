import * as z from "@oh-my-pi/omptype/zod";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { constants, createReadStream, existsSync, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentName,
  hostPathSchema,
  idSchema,
  leaseHolder,
  shaSchema,
  type ConfigurationContext,
  type ExecutionTarget,
  type HostPath,
} from "./execution";
import {
  allocatedWorkerSchema,
  agentBindingSchema,
  deliveryReceiptSchema,
  helperConfigurationSchema,
  hostArgsSchemas,
  mutationOps,
  operationViewSchema,
  PROTOCOL,
  releaseReceiptSchema,
  reportReceiptSchema,
  validateHostRequest,
  validateHostResult,
  type AgentBinding,
  type AllocatedWorker,
  type DeliveryReceipt,
  type HelperConfiguration,
  type HostArgs,
  type HostReply,
  type HostRequest,
  type HostResult,
  type Invocation,
  type OperationView,
  type ReportFrame,
  type ResultOp,
} from "./helper-protocol";
import { assertContained, canonicalPath, HostFailure, pathsOverlap } from "./host-paths";
import { MAX_FRAME_BYTES, REPORT_CHUNK_BYTES } from "./remote";
import * as git from "./git";
import * as treehouse from "./treehouse";
import * as omp from "./omp";
import { lastResponse } from "./session";
import { codexHome } from "./codex";
import {
  execCommand,
  parseJson,
  stringAt,
  valueAt,
  type ExecResult,
  type RuntimeDeps,
  type WorkerRecord,
} from "./shared";
import { serializeLedger, writesLedger } from "./ledger-queue";

export type HostRuntime = {
  configuration: HelperConfiguration;
  deps: RuntimeDeps;
  local: boolean;
  configurationPath?: string;
  installationPath?: string;
  sessionRoots?: string[];
  /** Overrides the Claude Code transcript root for Claude worker sessions. */
  claudeSessionRoots?: string[];
  /** Overrides every Codex home's sessions folder for Codex worker sessions. */
  codexSessionRoots?: string[];
  discoverExecutable?: (name: string) => string | null;
};
const workerSchema = z
  .object({
    resource: allocatedWorkerSchema,
    binding: agentBindingSchema.optional(),
    sessionIdentity: z.string().optional(),
    reportReceipt: reportReceiptSchema.optional(),
    deliveryReceipt: deliveryReceiptSchema.optional(),
    releaseReceipt: releaseReceiptSchema.optional(),
    archiveOwned: z.boolean().optional(),
    legacyDeliveryBase: shaSchema.optional(),
    forgotten: z.boolean().optional(),
  })
  .strict();
const operationSchema = z
  .object({
    view: operationViewSchema,
    request: z.unknown().transform(validateHostRequest),
    allocationStarted: z.boolean().optional(),
    resetComplete: z.boolean().optional(),
    intent: deliveryReceiptSchema.optional(),
    originIdentity: z.string().optional(),
    releaseStarted: z.boolean().optional(),
    releaseIntent: releaseReceiptSchema.optional(),
    createdProject: hostPathSchema.optional(),
  })
  .strict();
const ledgerSchema = z
  .object({
    version: z.literal(1),
    hostId: idSchema,
    controllerId: idSchema,
    workers: z.record(z.string(), workerSchema),
    operations: z.record(z.string(), operationSchema),
    absentOperations: z.array(idSchema).optional(),
  })
  .strict();
type HostWorker = z.infer<typeof workerSchema>;
type LedgerOperation = z.infer<typeof operationSchema>;
type Ledger = z.infer<typeof ledgerSchema>;
type LedgerSession = { ledger: Ledger; path: string; save(): Promise<void> };

export function createHostRuntime(
  configuration: HelperConfiguration,
  deps: RuntimeDeps,
  options: Omit<HostRuntime, "configuration" | "deps" | "local"> & { local?: boolean } = {},
): HostRuntime {
  return {
    ...options,
    configuration: helperConfigurationSchema.parse(configuration),
    deps,
    local: options.local ?? false,
  };
}

export function helperConfigurationPath(): string {
  return (
    process.env.OMP_ORCHESTRATOR_HELPER_CONFIG ??
    join(homedir(), ".omp", "orchestrator", "helper.json")
  );
}

export async function loadHelperConfiguration(
  path = helperConfigurationPath(),
): Promise<HelperConfiguration> {
  try {
    return helperConfigurationSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new HostFailure("PREREQUISITE_MISSING", "Helper configuration is missing or invalid.", {
      remedy: `Manually provision version 1 helper configuration at ${path}; preserve its hostId across upgrades.`,
    });
  }
}

export async function createLocalHostRuntime(
  deps: RuntimeDeps,
  options: {
    cwd: string;
    neutralRoot?: string;
    runtimeRoot?: string;
    overlayPath?: string;
    ompProfile?: string;
  },
): Promise<HostRuntime> {
  const configPath = helperConfigurationPath();
  try {
    await access(configPath);
    return createHostRuntime(await loadHelperConfiguration(configPath), deps, {
      local: true,
      configurationPath: configPath,
    });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const base = join(homedir(), ".omp", "orchestrator");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const identityPath = join(base, "host-id");
  let hostId: string;
  try {
    const file = await open(identityPath, "wx", 0o600);
    hostId = randomUUID();
    try {
      await file.writeFile(hostId);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    hostId = idSchema.parse((await readFile(identityPath, "utf8")).trim());
  }
  const runtimeRoot = options.runtimeRoot ?? join(base, "host-runtime");
  const neutralRoot = options.neutralRoot ?? join(base, "independent-workers");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await mkdir(neutralRoot, { recursive: true, mode: 0o700 });
  return createHostRuntime(
    {
      version: 1,
      hostId,
      overlayPath:
        options.overlayPath ??
        fileURLToPath(new URL("../../.omp/worker-config.yml", import.meta.url)),
      runtimeRoot,
      neutralRoot,
      queryCwd: options.cwd,
      approvedProjectRoots: [],
      ...(options.ompProfile ? { ompProfile: options.ompProfile } : {}),
      executables: {
        git: { executable: "git", prefixArgs: [] },
        treehouse: { executable: "treehouse", prefixArgs: [] },
        omp: { executable: "omp", prefixArgs: [] },
      },
    },
    deps,
    { local: true },
  );
}

export async function nativeExec(
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<ExecResult & { killed: boolean }> {
  if (/\.(?:cmd|bat|ps1)$/i.test(command))
    throw new HostFailure("PREREQUISITE_MISSING", "Shell shims cannot safely accept worker data.", {
      remedy:
        "Configure a native .exe or an absolute Bun/Node executable plus an absolute entry-file prefix argument.",
    });
  if (options.signal?.aborted)
    throw new HostFailure("TIMEOUT", "Host command cancelled before execution.");
  const { promise, resolve, reject } = Promise.withResolvers<ExecResult & { killed: boolean }>();
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let killed = false;
  let grace: NodeJS.Timeout | undefined;
  const finish = () => {
    clearTimeout(timer);
    clearTimeout(grace);
    options.signal?.removeEventListener("abort", stop);
  };
  const stop = () => {
    if (killed) return;
    killed = true;
    if (child.pid) {
      if (process.platform === "win32") {
        const treeKiller = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        treeKiller.on("error", () => child.kill("SIGKILL"));
        const killDeadline = setTimeout(() => treeKiller.kill("SIGKILL"), 1_000);
        treeKiller.on("close", () => clearTimeout(killDeadline));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }
    // A descendant may escape the process group while retaining our pipes.
    grace = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
      resolve({ stdout, stderr, code: child.exitCode ?? 1, killed });
    }, 1_000);
  };
  const timer = setTimeout(stop, options.timeout ?? 120_000);
  options.signal?.addEventListener("abort", stop, { once: true });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("close", (code) => {
    finish();
    resolve({ stdout, stderr, code: code ?? 1, killed });
  });
  child.on("error", () => {
    finish();
    reject(
      new HostFailure("PREREQUISITE_MISSING", "Configured host executable could not be started.", {
        remedy:
          "Manually provision the executable on PATH or set an absolute native invocation in helper.json.",
      }),
    );
  });
  if (options.signal?.aborted) stop();
  return promise;
}

async function invocation(
  runtime: HostRuntime,
  name: "git" | "treehouse" | "omp",
): Promise<Invocation> {
  const configured = runtime.configuration.executables[name];
  let executable = configured.executable;
  if (!isAbsolute(executable)) {
    if (/[\\/]/.test(executable))
      throw new HostFailure(
        "PATH_INVALID",
        "Executable must be absolute or a bare PATH-discovered command.",
      );
    const resolved = (runtime.discoverExecutable ?? Bun.which)(executable);
    if (!resolved)
      throw new HostFailure("PREREQUISITE_MISSING", `Required executable ${name} is missing.`, {
        remedy: `Manually install/configure ${name} for the SSH user; the helper never installs tools.`,
      });
    executable = resolved;
  }
  if (/\.(cmd|bat|ps1)$/i.test(executable))
    throw new HostFailure(
      "PREREQUISITE_MISSING",
      `${name} resolves to an unsupported shell shim.`,
      {
        remedy:
          "Configure a native executable or absolute Bun/Node runtime plus absolute entry-file prefixArgs; never cmd /c with worker data.",
      },
    );
  for (const arg of configured.prefixArgs) {
    if (
      arg.includes("\0") ||
      (!arg.startsWith("-") &&
        !arg.includes("=") &&
        /[\\/]|\.(?:js|mjs|cjs|ts)$/i.test(arg) &&
        !isAbsolute(arg))
    )
      throw new HostFailure(
        "PATH_INVALID",
        "Executable entry-file prefix arguments must be absolute host paths.",
      );
  }
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new HostFailure(
      "PREREQUISITE_MISSING",
      `Configured ${name} executable is missing or not executable.`,
      { remedy: "Manually provision a native executable or safe runtime/entry-file invocation." },
    );
  }
  return { executable, prefixArgs: configured.prefixArgs };
}

function hostDeps(runtime: HostRuntime, context?: ConfigurationContext): RuntimeDeps {
  return {
    ...runtime.deps,
    exec: async (name, args, options) => {
      if (name !== "git" && name !== "treehouse" && name !== "omp")
        throw new HostFailure(
          "INVALID_REQUEST",
          "Host runtime accepts only domain tool invocations.",
        );
      const call = await invocation(runtime, name);
      const contextual =
        name === "omp"
          ? [
              ...(context?.ompProfile ? ["--profile", context.ompProfile] : []),
              ...(context ? [`--config=${context.overlayPath}`] : []),
            ]
          : [];
      const result = await runtime.deps.exec(
        call.executable,
        [...call.prefixArgs, ...contextual, ...args],
        { ...options, timeout: options?.timeout ?? 120_000 },
      );
      if (result.killed)
        throw new HostFailure(
          "TIMEOUT",
          "Host command deadline reached; reconcile any mutation before retrying.",
          { effect: "unknown", retry: "reconcile" },
        );
      return result;
    },
  };
}
async function integrationCheck(
  runtime: HostRuntime,
): Promise<HostResult<"preflight">["tools"][number]> {
  const executable = (runtime.discoverExecutable ?? Bun.which)("herdr");
  if (!executable || /\.(?:cmd|bat|ps1)$/i.test(executable))
    throw new HostFailure(
      "PREREQUISITE_MISSING",
      "Herdr is unavailable as a native executable on the helper host.",
      { remedy: "Manually install Herdr and its OMP integration for the SSH user." },
    );
  const result = await runtime.deps.exec(executable, ["integration", "status"], {
    timeout: 30_000,
  });
  if (result.code || result.killed)
    throw new HostFailure(
      "CAPABILITY_MISSING",
      "Host-local Herdr integration status could not be queried.",
      {
        remedy:
          "Check herdr integration status on the target host; install/update the OMP integration manually.",
      },
    );
  const match = /^omp:\s*(?:current|outdated)\s*\(v(\d+)\b/m.exec(result.stdout);
  if (!match || Number(match[1]) < 3)
    throw new HostFailure(
      "CAPABILITY_MISSING",
      "Host-local Herdr OMP integration is absent or older than version 3.",
      {
        remedy:
          "Manually install/update Herdr's OMP integration on this host; the helper does not forward integration status through --machine.",
      },
    );
  return {
    name: "herdr-omp-integration",
    available: true,
    version: match[1]!,
    capabilities: ["omp-session-reference"],
  };
}

async function claudeCheck(
  runtime: HostRuntime,
): Promise<HostResult<"preflight">["tools"][number]> {
  const executable = (runtime.discoverExecutable ?? Bun.which)("claude");
  if (!executable || /\.(?:cmd|bat|ps1)$/i.test(executable))
    throw new HostFailure(
      "PREREQUISITE_MISSING",
      "Claude Code is unavailable as a native executable on this host.",
      { remedy: "Manually install Claude Code and sign it in for this user." },
    );
  const result = await runtime.deps.exec(executable, ["--version"], { timeout: 30_000 });
  if (result.code || result.killed)
    throw new HostFailure("PREREQUISITE_MISSING", "Claude Code --version failed on this host.", {
      remedy: "Repair the Claude Code installation manually.",
    });
  return { name: "claude", available: true, version: result.stdout.trim(), capabilities: [] };
}

async function codexCheck(runtime: HostRuntime): Promise<HostResult<"preflight">["tools"][number]> {
  const executable = (runtime.discoverExecutable ?? Bun.which)("codex");
  if (!executable || /\.(?:cmd|bat|ps1)$/i.test(executable))
    throw new HostFailure(
      "PREREQUISITE_MISSING",
      "Codex is unavailable as a native executable on this host.",
      { remedy: "Manually install the Codex CLI and sign it in for this user." },
    );
  const result = await runtime.deps.exec(executable, ["--version"], { timeout: 30_000 });
  if (result.code || result.killed)
    throw new HostFailure("PREREQUISITE_MISSING", "Codex --version failed on this host.", {
      remedy: "Repair the Codex CLI installation manually.",
    });
  return { name: "codex", available: true, version: result.stdout.trim(), capabilities: [] };
}

async function settings(
  runtime: HostRuntime,
): Promise<{ runtimeRoot: HostPath; neutralRoot: HostPath; approved: HostPath[] }> {
  const config = runtime.configuration;
  const runtimeRoot = await canonicalPath(config.runtimeRoot);
  const neutralRoot = await canonicalPath(config.neutralRoot);
  const approved = await Promise.all(
    config.approvedProjectRoots.map((path) => canonicalPath(path)),
  );
  const protectedPaths = [
    config.overlayPath,
    runtime.configurationPath,
    runtime.installationPath,
  ].filter((path): path is string => !!path);
  if (await pathsOverlap(runtimeRoot, neutralRoot))
    throw new HostFailure(
      "CONFIG_MISMATCH",
      "Runtime and neutral roots must be separate non-nested directories.",
    );
  for (const root of [runtimeRoot, neutralRoot]) {
    if (!(await stat(root.path)).isDirectory())
      throw new HostFailure("PATH_INVALID", "Configured runtime/neutral root is not a directory.");
    await access(root.path, constants.W_OK);
    for (const boundary of [...approved, ...protectedPaths])
      if (await pathsOverlap(root, boundary))
        throw new HostFailure(
          "PATH_FORBIDDEN",
          "Runtime/neutral roots overlap approved project or helper configuration/installation paths.",
        );
  }
  return { runtimeRoot, neutralRoot, approved };
}

async function projectPath(
  runtime: HostRuntime,
  value: string,
  missing = false,
): Promise<HostPath> {
  const path = await canonicalPath(value, { allowMissing: missing });
  const roots = await settings(runtime);
  if (
    (await pathsOverlap(path, roots.runtimeRoot)) ||
    (await pathsOverlap(path, roots.neutralRoot))
  )
    throw new HostFailure("PATH_FORBIDDEN", "Project path overlaps host runtime or neutral roots.");
  if (!runtime.local || roots.approved.length) {
    let approved = false;
    for (const root of roots.approved) {
      try {
        await assertContained(root, path, { allowMissing: missing });
        approved = true;
        break;
      } catch (error) {
        if (!(error instanceof HostFailure) || error.detail.code !== "PATH_FORBIDDEN") throw error;
      }
    }
    if (!approved)
      throw new HostFailure(
        "PATH_FORBIDDEN",
        "Project path is outside helper-approved project roots.",
        {
          remedy:
            "Manually add the intended host boundary to approvedProjectRoots; do not move retained workers.",
        },
      );
  }
  return path;
}

async function gitRoot(runtime: HostRuntime, value: string): Promise<HostPath> {
  const path = await projectPath(runtime, value);
  let actual: HostPath;
  try {
    actual = await canonicalPath(await git.topLevel(hostDeps(runtime), { cwd: path.path }));
  } catch (error) {
    if (error instanceof HostFailure) throw error;
    throw new HostFailure("PATH_INVALID", "Path is not an exact non-bare Git working root.");
  }
  if (actual.pathKey !== path.pathKey)
    throw new HostFailure(
      "PATH_INVALID",
      "Register the exact non-bare Git working root, not a subdirectory.",
    );
  return path;
}

async function contextFor(
  runtime: HostRuntime,
  supplied?: ConfigurationContext,
): Promise<ConfigurationContext> {
  const config = runtime.configuration;
  let overlay: HostPath;
  try {
    overlay = await canonicalPath(config.overlayPath);
  } catch {
    throw new HostFailure("PREREQUISITE_MISSING", "Worker overlay is unavailable.", {
      remedy: "Manually provision the approved worker-config.yml artifact.",
    });
  }
  if (supplied && (await canonicalPath(supplied.overlayPath)).pathKey !== overlay.pathKey)
    throw new HostFailure(
      "CONFIG_MISMATCH",
      "Query overlay differs from the provisioned worker overlay.",
    );
  let bytes: Buffer;
  try {
    bytes = await readFile(overlay.path);
  } catch {
    throw new HostFailure("PREREQUISITE_MISSING", "Worker overlay is unavailable.", {
      remedy: "Manually provision the approved worker-config.yml artifact.",
    });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (supplied && (supplied.overlaySha256 !== digest || supplied.ompProfile !== config.ompProfile))
    throw new HostFailure(
      "CONFIG_MISMATCH",
      "Worker overlay hash/profile changed; byte hashes include CRLF versus LF.",
      {
        remedy:
          "Restore the approved overlay bytes and original profile; the helper never copies configuration.",
      },
    );
  const cwd = await canonicalPath(supplied?.cwd ?? config.queryCwd);
  return {
    cwd: cwd.path,
    overlayPath: overlay.path,
    overlaySha256: digest,
    ...(config.ompProfile ? { ompProfile: config.ompProfile } : {}),
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function ledgerSession(runtime: HostRuntime, controllerId: string): Promise<LedgerSession> {
  idSchema.parse(controllerId);
  const roots = await settings(runtime);
  const directory = join(roots.runtimeRoot.path, "controllers", controllerId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertContained(roots.runtimeRoot, directory, { allowEqual: false });
  const path = join(directory, "ledger.json");
  let ledger: Ledger;
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new HostFailure(
        "PATH_FORBIDDEN",
        "Helper ledger was replaced by a symlink/junction; retain it for inspection.",
      );
    ledger = ledgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
      throw new HostFailure(
        "CONFIG_MISMATCH",
        "Host ledger is invalid; retain it for recovery, do not overwrite.",
      );
    ledger = {
      version: 1,
      hostId: runtime.configuration.hostId,
      controllerId,
      workers: {},
      operations: {},
    };
  }
  if (ledger.hostId !== runtime.configuration.hostId || ledger.controllerId !== controllerId)
    throw new HostFailure("HOST_MISMATCH", "Host ledger belongs to another host/controller.");
  for (const op of Object.values(ledger.operations))
    if (op.view.result !== undefined) validateHostResult(op.request.op as ResultOp, op.view.result);
  return { ledger, path, save: () => atomicJson(path, ledger) };
}

function requestHash(request: HostRequest): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  return createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          controllerId: request.controllerId,
          expectedHostId: request.expectedHostId,
          operationId: request.operationId,
          op: request.op,
          args: request.args,
        }),
      ),
    )
    .digest("hex");
}

function effectStarted(operation: LedgerOperation): boolean {
  return !!(
    operation.allocationStarted ||
    operation.releaseStarted ||
    operation.intent ||
    operation.createdProject ||
    operation.view.checkpoint?.deliveryBase
  );
}

async function locked<T>(
  path: string,
  work: () => Promise<T>,
  beforeLedger?: () => Promise<boolean>,
): Promise<T> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch {
    const noEffect = beforeLedger ? await beforeLedger() : false;
    throw new HostFailure(
      noEffect ? "LOCK_BUSY" : "OPERATION_UNCERTAIN",
      "Host mutation lock is busy or retained after interruption; no operation was replayed.",
      {
        effect: noEffect ? "none" : "unknown",
        retry: noEffect ? "user_action" : "reconcile",
        remedy:
          "Inspect the ledger and confirm the original helper/child is stopped before manually clearing its lock directory.",
      },
    );
  }
  try {
    return await work();
  } finally {
    await rmdir(path);
  }
}

function ownedWorker(session: LedgerSession, launchId: string): HostWorker {
  const worker = session.ledger.workers[launchId];
  if (!worker || worker.forgotten)
    throw new HostFailure(
      "RESOURCE_NOT_FOUND",
      "No owned worker resource for this controller/launch.",
    );
  return worker;
}

async function treehouseLeases(
  runtime: HostRuntime,
  project: HostPath,
): Promise<treehouse.TreehouseLease[]> {
  const value = parseJson(
    await execCommand(hostDeps(runtime), "treehouse", ["status", "--json"], { cwd: project.path }),
    "treehouse status",
  );
  const entries = z
    .array(
      z
        .object({
          path: z.string(),
          lease_id: z.string().optional(),
          lease_holder: z.string().optional(),
        })
        .passthrough(),
    )
    .parse(value);
  return entries.flatMap((entry) =>
    entry.lease_id && entry.lease_holder
      ? [{ path: entry.path, leaseId: entry.lease_id, leaseHolder: entry.lease_holder }]
      : [],
  );
}

async function verifyResource(runtime: HostRuntime, resource: AllocatedWorker): Promise<void> {
  const actual = await canonicalPath(resource.directory.path);
  if (actual.pathKey !== resource.directory.pathKey)
    throw new HostFailure(
      "LEASE_MISMATCH",
      "Owned directory identity changed; no reset/delivery/cleanup is safe.",
    );
  if (resource.scope === "project") {
    if (
      (await gitRoot(runtime, resource.project.path)).pathKey !== resource.project.pathKey ||
      (await pathsOverlap(resource.project, resource.directory))
    )
      throw new HostFailure("LEASE_MISMATCH", "Lease aliases/overlaps the registered source root.");
    const matches = (await treehouseLeases(runtime, resource.project)).filter(
      (lease) =>
        lease.leaseId === resource.lease.leaseId &&
        lease.leaseHolder === resource.lease.leaseHolder,
    );
    if (
      matches.length !== 1 ||
      (await canonicalPath(matches[0]!.path)).pathKey !== resource.directory.pathKey ||
      resource.lease.pathKey !== resource.directory.pathKey
    )
      throw new HostFailure(
        "LEASE_MISMATCH",
        "Treehouse lease ownership changed; restore the original lease before managing retained work.",
      );
    const deps = hostDeps(runtime);
    if (
      (await canonicalPath(await git.topLevel(deps, { cwd: resource.directory.path }))).pathKey !==
      resource.directory.pathKey
    )
      throw new HostFailure("LEASE_MISMATCH", "Treehouse lease is not an exact Git working root.");
    const commonDirs = await Promise.all(
      [resource.project.path, resource.directory.path].map(async (path) =>
        canonicalPath(
          await execCommand(deps, "git", [
            "-C",
            path,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]),
        ),
      ),
    );
    if (commonDirs[0]!.pathKey !== commonDirs[1]!.pathKey)
      throw new HostFailure(
        "LEASE_MISMATCH",
        "Treehouse lease does not share the registered repository's object database.",
      );
  } else
    await assertContained((await settings(runtime)).neutralRoot, resource.directory, {
      allowEqual: false,
    });
}

async function checkpoint(
  session: LedgerSession,
  operation: LedgerOperation,
  value: NonNullable<OperationView["checkpoint"]>,
): Promise<void> {
  operation.view.checkpoint = { ...operation.view.checkpoint, ...value };
  await session.save();
}

function hello(runtime: HostRuntime): HostResult<"hello"> {
  if (process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32")
    throw new HostFailure("CAPABILITY_MISSING", "Helper requires Linux, macOS or native Windows.");
  return {
    helperVersion: "1.0.0",
    buildId: "s2-host-runtime-v1",
    hostId: runtime.configuration.hostId,
    os: process.platform,
    arch: process.arch,
    capabilities: Object.keys(hostArgsSchemas).concat([
      "report.stream-v1",
      "operation.reconcile",
      "host.native-paths",
    ]),
    maxFrameBytes: MAX_FRAME_BYTES,
    reportChunkBytes: REPORT_CHUNK_BYTES,
  };
}

async function snapshot(
  runtime: HostRuntime,
  args: HostArgs["project.snapshot"],
): Promise<HostResult<"project.snapshot">> {
  const project = await gitRoot(runtime, args.projectPath);
  const deps = hostDeps(runtime);
  const head = await git.headAt(deps, project.path);
  const excludedChanges = await git.statusAt(deps, project.path);
  let branch: string | undefined;
  try {
    branch = await git.currentBranchAt(deps, project.path);
  } catch {
    /* Detached scouts still have a committed source. */
  }
  const starts: Record<string, string> = {};
  const originWarnings: Record<string, string> = {};
  for (const task of args.tasks) {
    if (task.startFrom) await git.checkBranch(deps, task.startFrom, { cwd: project.path });
    if (task.pushTo) await git.checkBranch(deps, task.pushTo, { cwd: project.path });
    if (task.kind === "implementation" && !task.pushTo) {
      if (excludedChanges)
        throw new HostFailure(
          "TARGET_DIRTY",
          "Default delivery requires a clean registered checkout.",
        );
      if (!branch || (task.startFrom && task.startFrom !== branch))
        throw new HostFailure(
          "BRANCH_CHANGED",
          "Default delivery requires the checked-out named start branch.",
        );
    }
    const sha = task.startFrom
      ? await git.branchHead(deps, task.startFrom, { cwd: project.path })
      : head;
    starts[task.name] = sha;
    const warning = await git.originLag(deps, project.path, task.startFrom ?? "HEAD", sha);
    if (warning) originWarnings[task.name] = warning;
  }
  return { project, head, ...(branch ? { branch } : {}), excludedChanges, starts, originWarnings };
}

async function allocate(
  runtime: HostRuntime,
  session: LedgerSession,
  request: HostRequest<"worker.allocate">,
  operation: LedgerOperation,
): Promise<AllocatedWorker> {
  const args = request.args;
  if (session.ledger.workers[args.launchId]) {
    const uncertain = Object.values(session.ledger.operations).some(
      (op) =>
        op.request.op === "worker.allocate" &&
        op.request.args.launchId === args.launchId &&
        op.view.state !== "confirmed" &&
        op !== operation,
    );
    throw new HostFailure(
      uncertain ? "OPERATION_UNCERTAIN" : "DESTINATION_CONFLICT",
      "Launch already owns a directory; allocate is never replayed.",
      { effect: uncertain ? "unknown" : "none", retry: uncertain ? "reconcile" : "user_action" },
    );
  }
  const roots = await settings(runtime);
  for (const forbidden of args.forbiddenRoots) {
    const actual = await canonicalPath(forbidden.path, { allowMissing: true });
    if (actual.pathKey !== forbidden.pathKey)
      throw new HostFailure("PATH_FORBIDDEN", "Forbidden root identity changed.");
    if (
      (await pathsOverlap(roots.runtimeRoot, forbidden)) ||
      (await pathsOverlap(roots.neutralRoot, forbidden))
    )
      throw new HostFailure(
        "PATH_FORBIDDEN",
        "Runtime/neutral root overlaps a registered controller/project boundary.",
      );
  }
  let resource: AllocatedWorker;
  const reportSourcePath =
    args.kind === "scout"
      ? join(dirname(session.path), "reports", `${args.launchId}.md`)
      : undefined;
  if (reportSourcePath) await mkdir(dirname(reportSourcePath), { recursive: true, mode: 0o700 });
  if (args.scope === "project") {
    const project = await gitRoot(runtime, args.projectPath);
    const holder = leaseHolder(request.controllerId, args.launchId);
    if ((await treehouseLeases(runtime, project)).some((lease) => lease.leaseHolder === holder))
      throw new HostFailure(
        "OPERATION_UNCERTAIN",
        "A prior lease exists for this launch; lookup/reconcile instead of allocating again.",
        { effect: "unknown", retry: "reconcile" },
      );
    operation.allocationStarted = true;
    await session.save();
    const lease = await treehouse.acquireLease(hostDeps(runtime), project.path, holder);
    if (lease.leaseHolder !== holder)
      throw new HostFailure("LEASE_MISMATCH", "Treehouse returned a foreign lease holder.", {
        effect: "unknown",
        retry: "reconcile",
      });
    const directory = await canonicalPath(lease.path);
    resource = {
      launchId: args.launchId,
      kind: args.kind,
      scope: "project",
      project,
      sourceHead: args.sourceHead,
      directory,
      lease: { ...lease, path: directory.path, pathKey: directory.pathKey },
      ...(reportSourcePath ? { reportSourcePath } : {}),
    };
    session.ledger.workers[args.launchId] = { resource };
    await checkpoint(session, operation, { resource });
    await verifyResource(runtime, resource);
    await git.resetHard(hostDeps(runtime), directory.path, args.sourceHead);
    if ((await git.headAt(hostDeps(runtime), directory.path)) !== args.sourceHead)
      throw new HostFailure(
        "OPERATION_UNCERTAIN",
        "Lease reset did not prove the captured source SHA.",
        { effect: "unknown", retry: "reconcile" },
      );
  } else {
    const path = join(roots.neutralRoot.path, request.controllerId, args.launchId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await assertContained(roots.neutralRoot, dirname(path), { allowEqual: false });
    operation.allocationStarted = true;
    await session.save();
    await mkdir(path, { mode: 0o700 });
    resource = {
      launchId: args.launchId,
      kind: "scout",
      scope: "independent",
      directory: await canonicalPath(path),
      reportSourcePath: reportSourcePath!,
    };
    session.ledger.workers[args.launchId] = { resource };
    await checkpoint(session, operation, { resource });
  }
  operation.resetComplete = true;
  await session.save();
  return resource;
}

async function inspect(
  runtime: HostRuntime,
  session: LedgerSession,
  launchId: string,
): Promise<HostResult<"worker.inspect">> {
  const worker = ownedWorker(session, launchId);
  await verifyResource(runtime, worker.resource);
  const resource = worker.resource;
  const result: HostResult<"worker.inspect"> = {
    launchId,
    directory: resource.directory,
    leaseValid: true,
    ...(worker.deliveryReceipt ? { deliveryReceipt: worker.deliveryReceipt } : {}),
  };
  if (resource.scope === "project") {
    result.dirty = await git.statusAt(hostDeps(runtime), resource.directory.path);
    result.head = await git.headAt(hostDeps(runtime), resource.directory.path);
    result.projectHead = await git.headAt(hostDeps(runtime), resource.project.path);
    try {
      result.branch = await git.currentBranchAt(hostDeps(runtime), resource.project.path);
    } catch {
      /* Branch absence is evidence, not a fabricated name. */
    }
    result.workerIsDelivered = await git.isAncestor(
      hostDeps(runtime),
      resource.project.path,
      result.head,
      result.projectHead,
    );
  }
  return result;
}

async function assertTarget(
  runtime: HostRuntime,
  project: HostPath,
  branch: string,
): Promise<string> {
  const deps = hostDeps(runtime);
  if ((await gitRoot(runtime, project.path)).pathKey !== project.pathKey)
    throw new HostFailure("PATH_FORBIDDEN", "Registered delivery root identity changed.");
  if (await git.statusAt(deps, project.path))
    throw new HostFailure(
      "TARGET_DIRTY",
      "Registered target is dirty; worker commits are retained.",
    );
  let current: string;
  try {
    current = await git.currentBranchAt(deps, project.path);
  } catch {
    throw new HostFailure(
      "BRANCH_CHANGED",
      "Registered target is detached; worker commits are retained.",
    );
  }
  if (current !== branch)
    throw new HostFailure(
      "BRANCH_CHANGED",
      "Registered target branch changed; worker commits are retained.",
    );
  return git.headAt(deps, project.path);
}

async function publicationProven(
  runtime: HostRuntime,
  directory: HostPath,
  receipt: Extract<DeliveryReceipt, { kind: "pushed" }>,
): Promise<boolean> {
  const deps = hostDeps(runtime);
  const origin = await execCommand(deps, "git", [
    "-C",
    directory.path,
    "remote",
    "get-url",
    "--push",
    "origin",
  ]);
  if (`sha256:${createHash("sha256").update(origin).digest("hex")}` !== receipt.originIdentity)
    return false;
  const remote = await execCommand(deps, "git", [
    "-C",
    directory.path,
    "ls-remote",
    "--refs",
    origin,
    receipt.ref,
  ]);
  const sha = remote.trim().split(/\s+/)[0];
  if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return false;
  if (sha === receipt.workerHead) return true;
  // Do not fetch objects or trust a moved ref whose ancestry is unavailable on this host.
  const object = await deps.exec("git", [
    "-C",
    directory.path,
    "cat-file",
    "-e",
    `${sha}^{commit}`,
  ]);
  if (object.code !== 0) return false;
  return git.isAncestor(deps, directory.path, receipt.workerHead, sha);
}

async function delivery(
  runtime: HostRuntime,
  session: LedgerSession,
  request: HostRequest<"delivery.land"> | HostRequest<"delivery.push">,
  operation: LedgerOperation,
): Promise<DeliveryReceipt> {
  const worker = ownedWorker(session, request.args.launchId);
  const resource = worker.resource;
  if (resource.scope !== "project" || resource.kind !== "implementation")
    throw new HostFailure(
      "INVALID_REQUEST",
      "Delivery requires an owned project implementation lease.",
    );
  await verifyResource(runtime, resource);
  const deps = hostDeps(runtime);
  if (await git.statusAt(deps, resource.directory.path))
    throw new HostFailure("TARGET_DIRTY", "Owned worker has uncommitted changes; retain it.");
  let workerHead = await git.headAt(deps, resource.directory.path);
  if (workerHead !== request.args.expectedWorkerHead)
    throw new HostFailure(
      "BRANCH_CHANGED",
      "Worker HEAD changed since approval; observe it before delivery.",
    );
  const locks = join(dirname(dirname(dirname(session.path))), "project-locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  return locked(
    join(locks, createHash("sha256").update(resource.project.pathKey).digest("hex")),
    async () => {
      let receipt: DeliveryReceipt;
      if (request.op === "delivery.push") {
        await git.checkBranch(deps, request.args.pushTo, { cwd: resource.directory.path });
        const origin = await execCommand(deps, "git", [
          "-C",
          resource.directory.path,
          "remote",
          "get-url",
          "--push",
          "origin",
        ]);
        // Origin URLs can contain credentials; receipts/ledgers need identity, not the URL.
        const originIdentity = `sha256:${createHash("sha256").update(origin).digest("hex")}`;
        const base = resource.sourceHead ?? worker.legacyDeliveryBase;
        if (!base)
          throw new HostFailure(
            "OPERATION_UNCERTAIN",
            "Legacy worker has no proven delivery base; retain it for explicit recovery.",
          );
        receipt = {
          id: randomUUID(),
          operationId: request.operationId,
          launchId: request.args.launchId,
          kind: "pushed",
          workerHead,
          deliveryBase: base,
          confirmedAt: new Date().toISOString(),
          originIdentity,
          ref: `refs/heads/${request.args.pushTo}`,
          targetHead: workerHead,
        };
        operation.intent = receipt;
        operation.originIdentity = originIdentity;
        await session.save();
        await git.pushHead(deps, resource.directory.path, request.args.pushTo);
      } else {
        let deliveryBase = request.args.deliveryBase;
        let targetHead = await assertTarget(runtime, resource.project, request.args.expectedBranch);
        if (workerHead === deliveryBase) {
          receipt = {
            id: randomUUID(),
            operationId: request.operationId,
            launchId: request.args.launchId,
            kind: "no_changes",
            workerHead,
            deliveryBase,
            confirmedAt: new Date().toISOString(),
            project: resource.project,
            branch: request.args.expectedBranch,
          };
        } else {
          if (!(await git.isAncestor(deps, resource.directory.path, deliveryBase, workerHead)))
            throw new HostFailure(
              "BRANCH_CHANGED",
              "Worker commits do not descend from the approved delivery base.",
            );
          if (!(await git.isAncestor(deps, resource.project.path, targetHead, workerHead))) {
            await checkpoint(session, operation, { deliveryBase: targetHead });
            try {
              await git.rebaseOnto(
                deps,
                resource.directory.path,
                targetHead,
                deliveryBase,
                workerHead,
              );
            } catch (error) {
              if (error instanceof HostFailure) throw error;
              await git.abortRebaseBestEffort(deps, resource.directory.path);
              if (
                !(await git.statusAt(deps, resource.directory.path)) &&
                (await git.headAt(deps, resource.directory.path)) === workerHead
              ) {
                // A proven rollback has no remaining rebase effect to reconcile.
                delete operation.view.checkpoint?.deliveryBase;
              }
              throw new HostFailure(
                "REBASE_CONFLICT",
                "Worker rebase failed; source checkout and worker lease are retained for inspection.",
              );
            }
            deliveryBase = targetHead;
            workerHead = await git.headAt(deps, resource.directory.path);
            await checkpoint(session, operation, { deliveryBase, rebasedHead: workerHead });
          }
          const fresh = await assertTarget(runtime, resource.project, request.args.expectedBranch);
          if (fresh !== targetHead)
            throw new HostFailure(
              "BRANCH_CHANGED",
              "Target moved again during delivery; rebased worker is retained without another rebase.",
            );
          receipt = {
            id: randomUUID(),
            operationId: request.operationId,
            launchId: request.args.launchId,
            kind: "merged",
            workerHead,
            deliveryBase,
            confirmedAt: new Date().toISOString(),
            project: resource.project,
            branch: request.args.expectedBranch,
            targetHead: workerHead,
          };
          operation.intent = receipt;
          await session.save();
          await git.fastForward(deps, resource.project.path, workerHead);
          targetHead = await assertTarget(runtime, resource.project, request.args.expectedBranch);
          if (targetHead !== workerHead)
            throw new HostFailure(
              "OPERATION_UNCERTAIN",
              "Target moved after fast-forward; retained receipt intent needs reconciliation.",
              { effect: "unknown", retry: "reconcile" },
            );
        }
      }
      worker.deliveryReceipt = receipt;
      await session.save();
      return receipt;
    },
    async () => true,
  );
}

export async function* streamHostReport(
  runtime: HostRuntime,
  request: HostRequest<"report.read">,
): AsyncGenerator<ReportFrame> {
  validateHostRequest(request);
  if (request.expectedHostId !== runtime.configuration.hostId)
    throw new HostFailure(
      "HOST_MISMATCH",
      "Helper identity changed; restore the original host binding.",
    );
  const session = await ledgerSession(runtime, request.controllerId);
  const worker = ownedWorker(session, request.args.launchId);
  const report = worker.resource.reportSourcePath;
  if (worker.resource.kind !== "scout" || !report)
    throw new HostFailure("REPORT_INVALID", "Launch has no staged scout report.");
  if (!worker.archiveOwned) {
    const staging = join(dirname(session.path), "reports");
    if ((await lstat(staging)).isSymbolicLink())
      throw new HostFailure(
        "REPORT_INVALID",
        "Report staging directory is a symlink/junction redirect.",
      );
    await assertContained((await settings(runtime)).runtimeRoot, staging, { allowEqual: false });
    await assertContained(staging, report, { allowEqual: false, allowMissing: true });
  }
  let before: BigIntStats;
  try {
    before = await lstat(report, { bigint: true });
  } catch {
    throw new HostFailure(
      "REPORT_INVALID",
      "Staged report is unavailable; keep the worker/staging record unless explicitly discarded.",
    );
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size === 0n ||
    before.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new HostFailure(
      "REPORT_INVALID",
      "Report must be a nonempty regular file, not a symlink/reparse redirect.",
    );
  const path = await canonicalPath(report);
  const directKey = `file:${before.dev}:${before.ino}`;
  if (path.pathKey !== directKey)
    throw new HostFailure("REPORT_INVALID", "Report identity was redirected.");
  const file = await open(
    report,
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const identity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
  const envelope = {
    protocol: PROTOCOL,
    version: 1,
    requestId: request.requestId,
    hostId: runtime.configuration.hostId,
  } as const;
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let hasContent = false;
  try {
    const opened = await file.stat({ bigint: true });
    if (
      `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}:${opened.ctimeNs}` !== identity
    )
      throw new HostFailure("REPORT_CHANGED", "Report changed before export.");
    yield {
      ...envelope,
      type: "begin",
      launchId: request.args.launchId,
      filename: basename(report),
      byteCount: Number(before.size),
      fileIdentity: identity,
    };
    let offset = 0;
    const buffer = Buffer.allocUnsafe(REPORT_CHUNK_BYTES);
    while (offset < Number(before.size)) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - offset),
        offset,
      );
      if (!bytesRead) throw new HostFailure("REPORT_CHANGED", "Report truncated during export.");
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      const text = decoder.decode(bytes, { stream: true });
      hasContent ||= /\S/u.test(text);
      yield { ...envelope, type: "chunk", offset, bytesBase64: bytes.toString("base64") };
      offset += bytesRead;
    }
    const remaining = decoder.decode();
    hasContent ||= /\S/u.test(remaining);
    const after = await lstat(report, { bigint: true });
    const held = await file.stat({ bigint: true });
    if (
      [after, held].some(
        (info) =>
          `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` !== identity,
      ) ||
      after.isSymbolicLink()
    )
      throw new HostFailure(
        "REPORT_CHANGED",
        "Report identity/size changed during export; retain staging.",
      );
    if (!hasContent) throw new HostFailure("REPORT_INVALID", "Report is empty/whitespace-only.");
    yield {
      ...envelope,
      type: "end",
      byteCount: offset,
      sha256: hash.digest("hex"),
      fileIdentity: identity,
    };
  } catch (error) {
    if (error instanceof HostFailure) throw error;
    throw new HostFailure("REPORT_INVALID", "Report is unavailable or is not valid UTF-8.");
  } finally {
    await file.close();
  }
}

async function assertReportReceipt(
  runtime: HostRuntime,
  session: LedgerSession,
  launchId: string,
  receipt: HostArgs["report.ack"]["receipt"],
): Promise<void> {
  const request: HostRequest<"report.read"> = {
    protocol: PROTOCOL,
    version: 1,
    requestId: randomUUID(),
    controllerId: session.ledger.controllerId,
    expectedHostId: runtime.configuration.hostId,
    op: "report.read",
    args: { launchId },
  };
  let end: Extract<ReportFrame, { type: "end" }> | undefined;
  for await (const frame of streamHostReport(runtime, request))
    if (frame.type === "end") end = frame;
  if (!end || end.sha256 !== receipt.sha256 || end.byteCount !== receipt.byteCount)
    throw new HostFailure(
      "REPORT_CHANGED",
      "Staged report differs from the controller's durable collection receipt; retain it.",
    );
}

async function absentLegacyReport(worker: HostWorker): Promise<boolean> {
  if (!worker.archiveOwned || !worker.resource.reportSourcePath) return false;
  try {
    await lstat(worker.resource.reportSourcePath);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function release(
  runtime: HostRuntime,
  session: LedgerSession,
  request: HostRequest<"worker.release">,
  operation: LedgerOperation,
): Promise<HostResult<"worker.release">> {
  const worker = ownedWorker(session, request.args.launchId);
  const args = request.args;
  if (
    worker.resource.scope === "project" &&
    (args.leaseId !== worker.resource.lease.leaseId ||
      args.leaseHolder !== worker.resource.lease.leaseHolder)
  )
    throw new HostFailure("LEASE_MISMATCH", "Release requires both exact stored lease guards.");
  if (worker.releaseReceipt) return worker.releaseReceipt;
  // A never-written legacy archive contains nothing to discard; staged remote evidence stays gated.
  const closingWithoutReport = args.proof === "closed" && (await absentLegacyReport(worker));
  if (
    worker.resource.kind === "scout" &&
    args.proof !== "discard" &&
    (!worker.reportReceipt || args.receiptId !== worker.reportReceipt.id) &&
    !closingWithoutReport
  )
    throw new HostFailure(
      "REPORT_INVALID",
      "Collect and acknowledge the staged report before closing/releasing a scout; explicit close alone is not discard authority.",
    );
  if (
    args.proof === "settled" &&
    worker.resource.kind === "implementation" &&
    (!worker.deliveryReceipt || args.receiptId !== worker.deliveryReceipt.id)
  )
    throw new HostFailure(
      "OPERATION_UNCERTAIN",
      "Settled release requires the helper's confirmed delivery receipt.",
    );
  await verifyResource(runtime, worker.resource);
  if (worker.resource.kind === "scout" && args.proof !== "discard" && !closingWithoutReport)
    await assertReportReceipt(runtime, session, args.launchId, worker.reportReceipt!);
  if (worker.resource.scope === "project") {
    if (args.proof !== "discard" && worker.resource.kind === "implementation") {
      const evidence = await inspect(runtime, session, args.launchId);
      const receiptCoversHead =
        worker.deliveryReceipt &&
        evidence.head === worker.deliveryReceipt.workerHead &&
        (worker.deliveryReceipt.kind !== "pushed" ||
          (await publicationProven(runtime, worker.resource.directory, worker.deliveryReceipt)));
      if (evidence.dirty || (!evidence.workerIsDelivered && !receiptCoversHead))
        throw new HostFailure(
          "TARGET_DIRTY",
          "Release would discard unlanded worker changes; retained unless explicitly discarded.",
        );
    }
  }
  operation.releaseStarted = true;
  const receipt: HostResult<"worker.release"> = {
    id: randomUUID(),
    operationId: request.operationId,
    launchId: args.launchId,
    path: worker.resource.directory,
    releasedAt: new Date().toISOString(),
    ...(worker.resource.scope === "project"
      ? {
          lease: {
            leaseId: worker.resource.lease.leaseId,
            leaseHolder: worker.resource.lease.leaseHolder,
          },
        }
      : {}),
  };
  operation.releaseIntent = receipt;
  await checkpoint(session, operation, { spaceClosed: true });
  if (worker.resource.scope === "project")
    await treehouse.returnLease(hostDeps(runtime), worker.resource.lease);
  else {
    const info = await lstat(worker.resource.directory.path);
    if (info.isSymbolicLink())
      throw new HostFailure(
        "PATH_FORBIDDEN",
        "Owned neutral directory was replaced by a symlink/junction; retained.",
      );
    await rm(worker.resource.directory.path, { recursive: true });
  }
  worker.releaseReceipt = receipt;
  await checkpoint(session, operation, { directoryReleased: true });
  return receipt;
}

async function execute(
  runtime: HostRuntime,
  session: LedgerSession,
  request: HostRequest,
  operation: LedgerOperation | undefined,
  ledgerLocked: boolean,
): Promise<unknown> {
  switch (request.op) {
    case "hello":
      return hello(runtime);
    case "preflight": {
      const roots = await settings(runtime);
      const context = await contextFor(runtime, request.args.context ?? undefined);
      if (context.overlaySha256 !== request.args.requiredOverlaySha256)
        throw new HostFailure(
          "CONFIG_MISMATCH",
          "Overlay bytes differ from the approved worker-config.yml (including CRLF/LF differences).",
          { remedy: "Manually restore approved overlay bytes; no configuration is copied." },
        );
      if (request.args.scope === "project") await gitRoot(runtime, request.args.projectPath);
      const agents = new Set(request.args.agents ?? ["omp"]);
      const names = [
        ...(request.args.scope === "project" ? ["git", "treehouse"] : []),
        ...(agents.has("omp") ? ["omp"] : []),
      ];
      const tools = [];
      for (const name of new Set([...names, ...(request.args.requiredTools ?? [])])) {
        if (name !== "git" && name !== "treehouse" && name !== "omp") {
          const binary = (runtime.discoverExecutable ?? Bun.which)(name);
          if (!binary || /\.(cmd|bat|ps1)$/i.test(binary))
            throw new HostFailure(
              "PREREQUISITE_MISSING",
              `Declared prerequisite ${name} is unavailable as a safe executable.`,
            );
          tools.push({ name, available: true, capabilities: [] });
          continue;
        }
        const version = await execCommand(
          hostDeps(runtime, name === "omp" ? context : undefined),
          name,
          ["--version"],
        );
        let capabilities: string[] = [];
        if (name === "treehouse") {
          const [get, status, returned] = await Promise.all([
            execCommand(hostDeps(runtime), name, ["get", "--help"]),
            execCommand(hostDeps(runtime), name, ["status", "--help"]),
            execCommand(hostDeps(runtime), name, ["return", "--help"]),
          ]);
          if (
            !get.includes("--lease-holder") ||
            !status.includes("--json") ||
            !returned.includes("--if-lease-id") ||
            !returned.includes("--if-lease-holder")
          )
            throw new HostFailure(
              "CAPABILITY_MISSING",
              "Treehouse lacks required durable lease/status/guarded-return capabilities.",
            );
          capabilities = ["lease", "status-json", "guarded-return"];
        }
        tools.push({ name, available: true, version, capabilities });
      }
      if (agents.has("omp")) {
        tools.push(await integrationCheck(runtime));
        await omp.chatModels(hostDeps(runtime, context), context.cwd);
        await omp.modelRoles(hostDeps(runtime, context), context.cwd);
      }
      if (agents.has("claude")) tools.push(await claudeCheck(runtime));
      if (agents.has("codex")) tools.push(await codexCheck(runtime));
      return {
        host: hello(runtime),
        context,
        runtimeRoot: roots.runtimeRoot,
        neutralRoot: roots.neutralRoot,
        overlaySha256: context.overlaySha256,
        tools,
      };
    }
    case "path.validate": {
      if (request.args.kind === "forbidden_root")
        return { path: await canonicalPath(request.args.path, { allowMissing: true }) };
      const path =
        request.args.kind === "git_root"
          ? await gitRoot(runtime, request.args.path)
          : await projectPath(runtime, request.args.path);
      if (!(await stat(path.path)).isDirectory())
        throw new HostFailure("PATH_INVALID", "Project root must be a directory.");
      return { path, ...(request.args.kind === "git_root" ? { gitRoot: path } : {}) };
    }
    case "project.create": {
      const destination = await projectPath(runtime, request.args.path, true);
      try {
        await lstat(destination.path);
        throw new HostFailure("DESTINATION_CONFLICT", "Project destination already exists.");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      operation!.createdProject = destination;
      await session.save();
      await mkdir(destination.path);
      const project = await canonicalPath(destination.path);
      operation!.createdProject = project;
      await session.save();
      try {
        await execCommand(hostDeps(runtime), "git", ["init", project.path]);
        await execCommand(hostDeps(runtime), "git", [
          "-C",
          project.path,
          "commit",
          "--allow-empty",
          "-m",
          "Initial commit",
        ]);
        return {
          registrationId: request.args.registrationId,
          project: await gitRoot(runtime, project.path),
          head: await git.headAt(hostDeps(runtime), project.path),
        };
      } catch {
        throw new HostFailure(
          "COMMAND_FAILED",
          `Project initialization failed; partial destination retained at ${project.path}.`,
          {
            effect: "unknown",
            retry: "reconcile",
            remedy:
              "Inspect the retained destination and host Git identity/prerequisites; no files were removed.",
          },
        );
      }
    }
    case "project.snapshot":
      return snapshot(runtime, request.args);
    case "worker.allocate":
      return allocate(runtime, session, request, operation!);
    case "worker.lookup": {
      const entries = Object.values(session.ledger.operations).filter(
        (op) => "launchId" in op.request.args && op.request.args.launchId === request.args.launchId,
      );
      const operations = await Promise.all(
        entries.map((op) => reconcileLedgerOperation(runtime, session, op, ledgerLocked)),
      );
      const worker = session.ledger.workers[request.args.launchId];
      return {
        launchId: request.args.launchId,
        ...(worker && !worker.forgotten
          ? { resource: worker.resource, ...(worker.binding ? { binding: worker.binding } : {}) }
          : {}),
        operations,
      };
    }
    case "worker.inspect":
      return inspect(runtime, session, request.args.launchId);
    case "worker.bind-agent": {
      const worker = ownedWorker(session, request.args.launchId);
      await verifyResource(runtime, worker.resource);
      const binding = { ...request.args.binding };
      if (
        binding.agentName !== agentName(request.controllerId, request.args.launchId) &&
        !(runtime.local && worker.binding?.agentName === binding.agentName)
      )
        throw new HostFailure(
          "AGENT_MISMATCH",
          "Agent alias does not belong to this controller/launch.",
        );
      if (
        (await canonicalPath(binding.cwd.path)).pathKey !== worker.resource.directory.pathKey ||
        binding.cwd.pathKey !== worker.resource.directory.pathKey ||
        binding.revision !== (worker.binding?.revision ?? 0) + 1
      )
        throw new HostFailure(
          "AGENT_MISMATCH",
          "Agent binding cwd/revision does not match the owned directory.",
        );
      if (worker.binding && worker.binding.session !== binding.session)
        throw new HostFailure(
          "AGENT_MISMATCH",
          "Relaunch cannot move the worker to another Herdr session.",
        );
      if (binding.identity === "codex") {
        // A Codex session reference is the worker's own directory; the session file is found
        // when it is read, because a relaunch starts a newer one in the same directory.
        if (binding.sessionPath && binding.sessionPath !== binding.cwd.path)
          throw new HostFailure(
            "AGENT_MISMATCH",
            "Codex session reference must be the worker's own directory.",
          );
        if (binding.codexHome !== undefined && !isAbsolute(binding.codexHome))
          throw new HostFailure("INVALID_REQUEST", "Codex home must be an absolute path.");
        delete worker.sessionIdentity;
      } else if (binding.codexHome !== undefined)
        throw new HostFailure("INVALID_REQUEST", "Only Codex workers have a Codex home.");
      else if (binding.sessionPath) {
        const sessionPath = await validateSession(runtime, binding.sessionPath, binding.identity);
        // A Claude binding keeps Herdr's session ID so later agent observations still match it.
        if (binding.identity !== "claude") binding.sessionPath = sessionPath.path;
        worker.sessionIdentity = sessionPath.pathKey;
      } else delete worker.sessionIdentity;
      worker.binding = binding;
      return { launchId: request.args.launchId, binding };
    }
    case "omp.context": {
      const context = await contextFor(runtime);
      if (context.overlaySha256 !== request.args.requiredOverlaySha256)
        throw new HostFailure(
          "CONFIG_MISMATCH",
          "Query overlay bytes differ from the approved worker-config.yml (including CRLF/LF).",
          { remedy: "Manually restore approved overlay bytes; no configuration is copied." },
        );
      return { context };
    }
    case "omp.models": {
      const context = await contextFor(runtime, request.args.context);
      const deps = hostDeps(runtime, context);
      const [catalog, roles] = await Promise.all([
        omp.chatModels(deps, context.cwd),
        omp.modelRoles(deps, context.cwd),
      ]);
      if (!roles.default)
        throw new HostFailure(
          "MODEL_UNAVAILABLE",
          "Selected host context has no configured default model role.",
        );
      let defaultChoice;
      try {
        defaultChoice = omp.resolveModel(catalog, roles.default);
      } catch {
        throw new HostFailure(
          "MODEL_UNAVAILABLE",
          "Selected host context's default model is unavailable; no controller catalog fallback.",
        );
      }
      return { context, catalog: [...catalog.values()], roles, defaultChoice };
    }
    case "omp.usage": {
      const context = await contextFor(runtime, request.args.context);
      return {
        ...(await omp.usageSummary(hostDeps(runtime, context), context.cwd, request.args.now)),
        context,
      };
    }
    case "session.last-response": {
      const worker = ownedWorker(session, request.args.launchId);
      if (!worker.binding?.sessionPath)
        return {
          unavailableReason: "No verified agent session reference was bound for this worker.",
        };
      let requested: HostPath, bound: HostPath;
      try {
        const kind = worker.binding.identity;
        const home = worker.binding.codexHome;
        if (kind === "codex" && request.args.sessionPath !== worker.binding.sessionPath)
          throw new HostFailure(
            "AGENT_MISMATCH",
            "Session reference differs from the verified worker binding.",
          );
        requested = await validateSession(runtime, request.args.sessionPath, kind, home);
        bound = await validateSession(runtime, worker.binding.sessionPath, kind, home);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return { unavailableReason: "Bound agent session file is unavailable." };
        throw error;
      }
      if (requested.pathKey !== bound.pathKey)
        throw new HostFailure(
          "AGENT_MISMATCH",
          "Session reference differs from the verified worker binding.",
        );
      if (worker.sessionIdentity && bound.pathKey !== worker.sessionIdentity)
        throw new HostFailure(
          "AGENT_MISMATCH",
          "Bound agent session file identity changed; retain the worker and verify a new binding revision.",
        );
      const text = await lastResponse(bound.path);
      return text
        ? { text }
        : { unavailableReason: "No assistant response is available in the bound agent session." };
    }
    case "report.read":
      throw new HostFailure("INVALID_REQUEST", "Use streamHostReport for streamed report export.");
    case "report.ack": {
      const worker = ownedWorker(session, request.args.launchId);
      if (request.args.receipt.launchId !== request.args.launchId)
        throw new HostFailure(
          "INVALID_REQUEST",
          "Report receipt launch does not match staged report.",
        );
      const receipt = request.args.receipt;
      await assertReportReceipt(runtime, session, request.args.launchId, receipt);
      worker.reportReceipt = receipt;
      return { receiptId: receipt.id, sha256: receipt.sha256, byteCount: receipt.byteCount };
    }
    case "delivery.land":
    case "delivery.push":
      return delivery(runtime, session, request, operation!);
    case "delivery.lookup": {
      const op = session.ledger.operations[request.args.operationId];
      if (
        !op ||
        !("launchId" in op.request.args) ||
        op.request.args.launchId !== request.args.launchId ||
        (op.request.op !== "delivery.land" && op.request.op !== "delivery.push")
      )
        throw new HostFailure(
          "RESOURCE_NOT_FOUND",
          "No matching delivery operation for this launch.",
        );
      const view = await reconcileLedgerOperation(runtime, session, op, ledgerLocked);
      return {
        operation: view,
        ...(view.state === "confirmed"
          ? { receipt: deliveryReceiptSchema.parse(view.result) }
          : {}),
      };
    }
    case "operation.get": {
      const op = session.ledger.operations[request.args.operationId];
      if (!op) {
        if (!session.ledger.absentOperations?.includes(request.args.operationId))
          throw new HostFailure(
            "OPERATION_UNCERTAIN",
            "Missing operation cannot be fenced while another helper owns the ledger.",
            { effect: "unknown", retry: "reconcile" },
          );
        throw new HostFailure(
          "OPERATION_NOT_STARTED",
          "Operation never entered the ledger and its ID is retired.",
          { effect: "none", retry: "user_action", operationId: request.args.operationId },
        );
      }
      return reconcileLedgerOperation(runtime, session, op, ledgerLocked);
    }
    case "worker.release":
      return release(runtime, session, request, operation!);
    case "worker.forget": {
      const worker = ownedWorker(session, request.args.launchId);
      if (!worker.releaseReceipt || worker.releaseReceipt.id !== request.args.cleanupReceiptId)
        throw new HostFailure(
          "OPERATION_UNCERTAIN",
          "Forget requires the exact confirmed cleanup receipt.",
        );
      if (worker.resource.reportSourcePath && !worker.archiveOwned) {
        const releaseOp = session.ledger.operations[worker.releaseReceipt.operationId];
        const discard =
          releaseOp?.request.op === "worker.release" && releaseOp.request.args.proof === "discard";
        if (!worker.reportReceipt && !discard)
          throw new HostFailure(
            "REPORT_INVALID",
            "Uncollected staged report is retained without explicit discard authority.",
          );
        if (!discard) {
          let present = true;
          try {
            await lstat(worker.resource.reportSourcePath);
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
              throw error;
            present = false;
          }
          // Deletion can succeed before the final ledger save; the acknowledged copy is durable.
          if (present)
            await assertReportReceipt(
              runtime,
              session,
              request.args.launchId,
              worker.reportReceipt!,
            );
        }
        const staging = dirname(worker.resource.reportSourcePath);
        if ((await lstat(staging)).isSymbolicLink())
          throw new HostFailure("REPORT_INVALID", "Staging directory was redirected; retain it.");
        await assertContained((await settings(runtime)).runtimeRoot, staging, {
          allowEqual: false,
        });
        await rm(worker.resource.reportSourcePath, { force: true });
      }
      session.ledger.workers[request.args.launchId] = {
        resource: worker.resource,
        releaseReceipt: worker.releaseReceipt,
        forgotten: true,
      };
      return { launchId: request.args.launchId, forgotten: true };
    }
  }
}

// Mirrors OMP's getSessionsDir. The extension cannot import @oh-my-pi/pi-utils: OMP's extension loader
// resolves it from this repo's node_modules, where its native dependency fails to load, and the whole
// extension is then rejected. Only the default agent dir moves under XDG_DATA_HOME, and only on Linux/macOS.
function sessionsDir(agentDir: string): string {
  const xdgData = process.env.XDG_DATA_HOME;
  if (
    xdgData &&
    (process.platform === "linux" || process.platform === "darwin") &&
    agentDir === join(homedir(), ".omp", "agent") &&
    existsSync(join(xdgData, "omp"))
  )
    return join(xdgData, "omp", "sessions");
  return join(agentDir, "sessions");
}

/** Claude Code keeps one transcript per session under its configuration's projects directory. */
function claudeSessionsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Find the transcript of a Claude Code session that Herdr names only by ID. */
async function claudeTranscript(roots: string[], id: string): Promise<string> {
  // Anything but a UUID could name a file outside the session's project folder.
  if (!CLAUDE_SESSION_ID.test(id))
    throw new HostFailure("AGENT_MISMATCH", "Claude Code session reference is not a session ID.");
  // Claude Code shortens and hashes the folder name of long working directories, so search for
  // the ID rather than re-deriving the folder from the worker's cwd.
  for (const root of roots) {
    let folders;
    try {
      folders = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const folder of folders) {
      const path = join(root, folder.name, `${id}.jsonl`);
      if (folder.isDirectory() && existsSync(path)) return path;
    }
  }
  // The session may not have written its transcript yet; callers treat this as unavailable.
  throw Object.assign(new Error(`Claude Code transcript ${id} does not exist yet`), {
    code: "ENOENT",
  });
}

/** Workers must not delegate, but a subagent session in the same directory is never the answer. */
function codexSubagent(meta: unknown): boolean {
  const source = valueAt(meta, ["source"]);
  return (
    stringAt(meta, ["thread_source"]) === "subagent" ||
    (!!source && typeof source === "object" && "subagent" in source)
  );
}

async function firstLine(path: string): Promise<string | undefined> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Find the newest Codex session started in a worker's directory. Codex files sessions under
 * YYYY/MM/DD folders with a timestamped name and records the working directory in the first
 * line, so a newest-first walk stops at the current session without reading older ones.
 */
async function codexSession(roots: string[], directory: string): Promise<string> {
  const entries = async (path: string) => {
    try {
      return (await readdir(path, { withFileTypes: true })).toSorted((a, b) =>
        b.name.localeCompare(a.name),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  };
  for (const root of roots)
    for (const year of await entries(root))
      for (const month of year.isDirectory() ? await entries(join(root, year.name)) : [])
        for (const day of month.isDirectory()
          ? await entries(join(root, year.name, month.name))
          : []) {
          if (!day.isDirectory()) continue;
          const folder = join(root, year.name, month.name, day.name);
          for (const file of await entries(folder)) {
            if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
            const path = join(folder, file.name);
            let meta: unknown;
            try {
              const entry = JSON.parse((await firstLine(path)) ?? "");
              if (stringAt(entry, ["type"]) !== "session_meta") continue;
              meta = valueAt(entry, ["payload"]);
            } catch {
              // A session Codex is still creating, or one that is not a Codex session.
              continue;
            }
            if (stringAt(meta, ["cwd"]) === directory && !codexSubagent(meta)) return path;
          }
        }
  // The worker may not have started its session yet; callers treat this as unavailable.
  throw Object.assign(new Error(`No Codex session exists yet for ${directory}`), {
    code: "ENOENT",
  });
}

async function validateSession(
  runtime: HostRuntime,
  value: string,
  kind: AgentBinding["identity"] = "omp",
  home?: string,
): Promise<HostPath> {
  let roots: string[];
  if (kind === "claude") roots = runtime.claudeSessionRoots ?? [claudeSessionsDir()];
  else if (kind === "codex")
    roots = runtime.codexSessionRoots ?? [join(codexHome(home), "sessions")];
  else {
    const context = await contextFor(runtime);
    const configDir = await execCommand(hostDeps(runtime, context), "omp", ["config", "path"], {
      cwd: context.cwd,
    });
    roots = runtime.sessionRoots ?? [sessionsDir(configDir)];
  }
  const path = await canonicalPath(
    kind === "claude"
      ? await claudeTranscript(roots, value)
      : kind === "codex"
        ? await codexSession(roots, value)
        : value,
  );
  for (const root of roots) {
    try {
      await assertContained(root, path, { allowEqual: false });
      if (!(await stat(path.path)).isFile()) break;
      return path;
    } catch (error) {
      if (!(error instanceof HostFailure) || error.detail.code !== "PATH_FORBIDDEN") throw error;
    }
  }
  throw new HostFailure(
    "AGENT_MISMATCH",
    "Session access is restricted to the agent's provisioned session root and bound worker reference.",
  );
}

export async function reconcileLedgerOperation(
  runtime: HostRuntime,
  session: LedgerSession,
  operation: LedgerOperation,
  ledgerLocked: boolean,
): Promise<OperationView> {
  if (operation.view.state === "confirmed" || operation.view.state === "refused")
    return operation.view;
  const request = operation.request;
  const uncertain = () => {
    operation.view.state = "uncertain";
    operation.view.error = new HostFailure(
      "OPERATION_UNCERTAIN",
      "Operation effect cannot be proven; retain resources and reconcile, never replay.",
      { effect: "unknown", retry: "reconcile", operationId: request.operationId },
    ).detail;
  };
  try {
    if (request.op === "project.create" && operation.createdProject) {
      const project = await gitRoot(runtime, operation.createdProject.path);
      if (project.pathKey !== operation.createdProject.pathKey)
        throw new HostFailure("PATH_FORBIDDEN", "Created project identity changed.");
      const head = await git.headAt(hostDeps(runtime), project.path);
      if (await git.statusAt(hostDeps(runtime), project.path))
        throw new HostFailure("TARGET_DIRTY", "Partial created project is dirty; retain it.");
      operation.view.state = "confirmed";
      operation.view.result = { registrationId: request.args.registrationId, project, head };
      delete operation.view.error;
      return operation.view;
    }
    if ("launchId" in request.args) {
      const worker = session.ledger.workers[request.args.launchId];
      let result: unknown;
      if (
        request.op === "worker.bind-agent" &&
        worker?.binding &&
        JSON.stringify(worker.binding) === JSON.stringify(request.args.binding)
      )
        result = { launchId: request.args.launchId, binding: worker.binding };
      if (
        request.op === "report.ack" &&
        worker?.reportReceipt &&
        JSON.stringify(worker.reportReceipt) === JSON.stringify(request.args.receipt)
      )
        result = {
          receiptId: worker.reportReceipt.id,
          sha256: worker.reportReceipt.sha256,
          byteCount: worker.reportReceipt.byteCount,
        };
      if (
        (request.op === "delivery.land" || request.op === "delivery.push") &&
        worker?.deliveryReceipt?.operationId === request.operationId
      )
        result = worker.deliveryReceipt;
      if (
        request.op === "worker.forget" &&
        worker?.forgotten &&
        worker.releaseReceipt?.id === request.args.cleanupReceiptId
      )
        result = { launchId: request.args.launchId, forgotten: true };
      if (result !== undefined) {
        operation.view.state = "confirmed";
        operation.view.result = validateHostResult(request.op as ResultOp, result);
        delete operation.view.error;
        return operation.view;
      }
    }
    // Without the lock, another helper can still be between preparation and its first effect.
    if (ledgerLocked && !effectStarted(operation)) {
      operation.view.state = "refused";
      operation.view.error = {
        ...(operation.view.error ??
          new HostFailure(
            "OPERATION_NOT_STARTED",
            "Operation stopped before a non-idempotent effect began.",
          ).detail),
        effect: "none",
        retry: "user_action",
        operationId: request.operationId,
      };
      delete operation.view.result;
      return operation.view;
    }
    if (
      request.op === "worker.allocate" &&
      request.args.scope === "project" &&
      operation.allocationStarted
    ) {
      const project = await gitRoot(runtime, request.args.projectPath);
      const holder = leaseHolder(request.controllerId, request.args.launchId);
      const matches = (await treehouseLeases(runtime, project)).filter(
        (lease) => lease.leaseHolder === holder,
      );
      if (matches.length === 1) {
        const lease = matches[0]!;
        const directory = await canonicalPath(lease.path);
        const resource: AllocatedWorker = {
          launchId: request.args.launchId,
          kind: request.args.kind,
          scope: "project",
          project,
          sourceHead: request.args.sourceHead,
          directory,
          lease: { ...lease, path: directory.path, pathKey: directory.pathKey },
          ...(request.args.kind === "scout"
            ? {
                reportSourcePath: join(
                  dirname(session.path),
                  "reports",
                  `${request.args.launchId}.md`,
                ),
              }
            : {}),
        };
        await verifyResource(runtime, resource);
        const existing = session.ledger.workers[request.args.launchId];
        if (existing && existing.resource.directory.pathKey !== directory.pathKey)
          throw new HostFailure(
            "LEASE_MISMATCH",
            "Multiple resource identities for the same launch.",
          );
        session.ledger.workers[request.args.launchId] ??= { resource };
        operation.view.checkpoint = { ...operation.view.checkpoint, resource };
        if (operation.resetComplete) {
          operation.view.state = "confirmed";
          operation.view.result = resource;
          delete operation.view.error;
          return operation.view;
        }
      }
    } else if (
      request.op === "worker.allocate" &&
      operation.resetComplete &&
      operation.view.checkpoint?.resource
    ) {
      await verifyResource(runtime, operation.view.checkpoint.resource);
      operation.view.state = "confirmed";
      operation.view.result = operation.view.checkpoint.resource;
      delete operation.view.error;
      return operation.view;
    } else if (
      (request.op === "delivery.land" || request.op === "delivery.push") &&
      operation.intent
    ) {
      const resource = ownedWorker(session, request.args.launchId).resource;
      if (resource.scope !== "project")
        throw new HostFailure("INVALID_REQUEST", "Delivery ledger resource is not a project.");
      const receipt = operation.intent;
      let proved = false;
      if (receipt.kind === "merged") {
        const target = await assertTarget(runtime, resource.project, receipt.branch);
        proved =
          target === receipt.workerHead ||
          (await git.isAncestor(
            hostDeps(runtime),
            resource.project.path,
            receipt.workerHead,
            target,
          ));
      } else if (receipt.kind === "pushed") {
        proved = await publicationProven(runtime, resource.directory, receipt);
      }
      if (proved) {
        session.ledger.workers[request.args.launchId]!.deliveryReceipt = receipt;
        operation.view.state = "confirmed";
        operation.view.result = receipt;
        delete operation.view.error;
        return operation.view;
      }
    } else if (request.op === "worker.release") {
      const worker = session.ledger.workers[request.args.launchId];
      let receipt = worker?.releaseReceipt;
      if (!receipt && worker && operation.releaseStarted && operation.releaseIntent) {
        let proved = false;
        const resource = worker.resource;
        if (resource.scope === "project") {
          const entries = z
            .array(
              z
                .object({
                  path: z.string(),
                  lease_id: z.string().optional(),
                  lease_holder: z.string().optional(),
                })
                .passthrough(),
            )
            .parse(
              parseJson(
                await execCommand(hostDeps(runtime), "treehouse", ["status", "--json"], {
                  cwd: resource.project.path,
                }),
                "treehouse status",
              ),
            );
          for (const entry of entries) {
            const directory = await canonicalPath(entry.path);
            if (
              directory.pathKey === resource.directory.pathKey &&
              entry.lease_id !== resource.lease.leaseId &&
              entry.lease_holder !== resource.lease.leaseHolder
            )
              proved = true;
          }
        } else {
          try {
            await lstat(resource.directory.path);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") proved = true;
            else throw error;
          }
        }
        if (proved) {
          receipt = operation.releaseIntent;
          worker.releaseReceipt = receipt;
          operation.view.checkpoint = { ...operation.view.checkpoint, directoryReleased: true };
        }
      }
      if (receipt) {
        operation.view.state = "confirmed";
        operation.view.result = receipt;
        delete operation.view.error;
        return operation.view;
      }
    }
    uncertain();
  } catch {
    uncertain();
  }
  return operation.view;
}

export async function reconcileHostOperation(
  runtime: HostRuntime,
  controllerId: string,
  operationId: string,
): Promise<OperationView> {
  const reply = await dispatchHostRequest(runtime, {
    protocol: PROTOCOL,
    version: 1,
    requestId: randomUUID(),
    controllerId,
    expectedHostId: runtime.configuration.hostId,
    op: "operation.get",
    args: { operationId },
  });
  if (!reply.ok) throw new HostFailure(reply.error.code, reply.error.message, reply.error);
  return reply.result;
}

export async function dispatchHostRequest<Op extends ResultOp>(
  runtime: HostRuntime,
  input: HostRequest<Op>,
): Promise<HostReply<Op>> {
  if (writesLedger(input.op))
    return serializeLedger(`host:${runtime.configuration.hostId}:${input.controllerId}`, () =>
      dispatchSerializedHostRequest(runtime, input),
    );
  return dispatchSerializedHostRequest(runtime, input);
}

async function dispatchSerializedHostRequest<Op extends ResultOp>(
  runtime: HostRuntime,
  input: HostRequest<Op>,
): Promise<HostReply<Op>> {
  const request = validateHostRequest(input);
  const envelope = {
    protocol: PROTOCOL,
    version: 1,
    requestId: request.requestId,
    hostId: runtime.configuration.hostId,
  } as const;
  try {
    if (request.expectedHostId && request.expectedHostId !== runtime.configuration.hostId)
      throw new HostFailure(
        "HOST_MISMATCH",
        "Helper hostId differs from the immutable machine binding.",
        {
          remedy:
            "Restore the original helper identity/SSH target; re-registration is for future launches only.",
        },
      );
    if (request.op === "hello")
      return { ...envelope, ok: true, result: hello(runtime) as HostResult<Op> };
    const initial = await ledgerSession(runtime, request.controllerId);
    const reconciles =
      request.op === "worker.lookup" ||
      request.op === "operation.get" ||
      request.op === "delivery.lookup";
    const run = async (session: LedgerSession, persistReconciliation = false) => {
      let operation: LedgerOperation | undefined;
      if (mutationOps[request.op]) {
        const id = request.operationId!;
        const hash = requestHash(request);
        if (session.ledger.absentOperations?.includes(id))
          throw new HostFailure(
            "OPERATION_NOT_STARTED",
            "Operation ID was retired before entering the ledger.",
            { effect: "none", retry: "never", operationId: id },
          );
        const existing = session.ledger.operations[id];
        if (existing) {
          if (existing.view.requestHash !== hash)
            throw new HostFailure(
              "INVALID_REQUEST",
              "Operation ID was reused with different controller/launch/payload data.",
              { retry: "never", operationId: id },
            );
          const view = await reconcileLedgerOperation(runtime, session, existing, true);
          await session.save();
          if (view.state === "confirmed") return validateHostResult(input.op, view.result);
          throw new HostFailure(
            view.error?.code ?? "OPERATION_UNCERTAIN",
            view.error?.message ?? "Prior operation is uncertain; never replayed.",
            view.error ?? { effect: "unknown", retry: "reconcile", operationId: id },
          );
        }
        operation = { request, view: { operationId: id, requestHash: hash, state: "prepared" } };
        session.ledger.operations[id] = operation;
        await session.save();
        operation.view.state = "running";
        await session.save();
      }
      const ledgerOnlyLaunch =
        request.op === "worker.bind-agent" ||
        request.op === "report.ack" ||
        request.op === "worker.forget"
          ? request.args.launchId
          : undefined;
      const originalWorker = ledgerOnlyLaunch
        ? structuredClone(session.ledger.workers[ledgerOnlyLaunch])
        : undefined;
      try {
        if (
          request.op === "operation.get" &&
          persistReconciliation &&
          !session.ledger.operations[request.args.operationId] &&
          !session.ledger.absentOperations?.includes(request.args.operationId)
        ) {
          // Fence late arrivals before telling the controller that a missing operation had no effect.
          (session.ledger.absentOperations ??= []).push(request.args.operationId);
          await session.save();
        }
        const result = await execute(
          runtime,
          session,
          request,
          operation,
          !!operation || persistReconciliation,
        );
        const operationResults = Object.fromEntries(
          Object.values(session.ledger.operations).map((op) => [
            op.view.operationId,
            op.request.op as ResultOp,
          ]),
        );
        const validated = validateHostResult(input.op, result, operationResults);
        if (operation) {
          operation.view.state = "confirmed";
          operation.view.result = validated;
          delete operation.view.error;
          await session.save();
        }
        if (reconciles && persistReconciliation) await session.save();
        return validated;
      } catch (error) {
        const failure =
          error instanceof HostFailure
            ? error
            : new HostFailure(
                "COMMAND_FAILED",
                "Host operation failed; inspect retained host resources and prerequisites.",
                {
                  effect: operation ? "unknown" : "none",
                  retry: operation ? "reconcile" : "user_action",
                },
              );
        if (operation) {
          // These updates commit with the result; failed saves must not persist a partial binding.
          if (ledgerOnlyLaunch && originalWorker)
            session.ledger.workers[ledgerOnlyLaunch] = originalWorker;
          const started = effectStarted(operation);
          failure.detail.effect = started ? "unknown" : "none";
          failure.detail.retry = started ? "reconcile" : "user_action";
          operation.view.state = started ? "uncertain" : "refused";
          delete operation.view.result;
          operation.view.error = { ...failure.detail, operationId: request.operationId };
          await session.save();
        } else if (!reconciles && failure.detail.code === "TIMEOUT") {
          failure.detail.effect = "none";
          failure.detail.retry = "user_action";
        }
        throw failure;
      }
    };
    let result: HostResult<Op>;
    const lock = join(dirname(initial.path), "mutation.lock");
    if (mutationOps[request.op])
      result = await locked(
        lock,
        async () => run(await ledgerSession(runtime, request.controllerId)),
        async () =>
          !(await ledgerSession(runtime, request.controllerId)).ledger.operations[
            request.operationId!
          ],
      );
    else if (reconciles) {
      let acquired = false;
      try {
        await mkdir(lock, { mode: 0o700 });
        acquired = true;
      } catch {
        /* Keep observations available while an original mutation may still run. */
      }
      try {
        result = await run(
          acquired ? await ledgerSession(runtime, request.controllerId) : initial,
          acquired,
        );
      } finally {
        if (acquired) await rmdir(lock);
      }
    } else result = await run(initial);
    return { ...envelope, ok: true, result };
  } catch (error) {
    const failure =
      error instanceof HostFailure
        ? error.detail
        : new HostFailure(
            "COMMAND_FAILED",
            "Host request could not be completed; inspect provisioned host paths/tools.",
          ).detail;
    return {
      ...envelope,
      ok: false,
      error: { ...failure, ...(request.operationId ? { operationId: request.operationId } : {}) },
    };
  }
}

export async function adoptLegacyLocalRecord(
  runtime: HostRuntime,
  record: WorkerRecord,
  verifiedTarget: ExecutionTarget,
  verifiedEvidence:
    | HostArgs["worker.bind-agent"]["binding"]
    | { closureOnly: true; session: string },
): Promise<AllocatedWorker> {
  const verifiedBinding = "identity" in verifiedEvidence ? verifiedEvidence : undefined;
  if (
    !runtime.local ||
    verifiedTarget.kind !== "local" ||
    verifiedTarget.hostId !== runtime.configuration.hostId ||
    record.target?.kind !== "unresolved_local" ||
    !record.controller_id ||
    !record.launch_id
  )
    throw new HostFailure(
      "INVALID_REQUEST",
      "Legacy adoption is local-only and requires migration IDs plus a verified local target/binding.",
    );
  if (
    !verifiedBinding &&
    (record.scope !== "project" ||
      record.kind !== "scout" ||
      record.status !== "failed" ||
      verifiedEvidence.session !== verifiedTarget.session)
  )
    throw new HostFailure(
      "INVALID_REQUEST",
      "Unbound legacy adoption requires explicit failed scout closure evidence.",
    );
  if (
    verifiedBinding &&
    (verifiedBinding.identity !== "omp" ||
      verifiedBinding.agentName !== (record.agent_name ?? record.name) ||
      verifiedBinding.session !== verifiedTarget.session ||
      verifiedBinding.paneId !== record.pane_id ||
      verifiedBinding.tabId !== record.tab_id ||
      verifiedBinding.workspaceId !== record.workspace_id)
  )
    throw new HostFailure(
      "AGENT_MISMATCH",
      "Legacy agent evidence does not match the retained local record.",
    );
  const directory = await canonicalPath(record.worktree ?? record.working_directory ?? "");
  if (
    verifiedBinding &&
    (verifiedBinding.cwd.pathKey !== directory.pathKey ||
      (await canonicalPath(verifiedBinding.cwd.path)).pathKey !== directory.pathKey)
  )
    throw new HostFailure(
      "AGENT_MISMATCH",
      "Legacy agent cwd does not match the retained directory.",
    );
  const session = await ledgerSession(runtime, record.controller_id);
  return locked(join(dirname(session.path), "mutation.lock"), async () => {
    const current = await ledgerSession(runtime, record.controller_id!);
    let resource: AllocatedWorker;
    if (record.scope === "project") {
      if (!record.projectPath || !record.lease_id || !record.lease_holder)
        throw new HostFailure("LEASE_MISMATCH", "Legacy lease metadata is incomplete.");
      const project = await gitRoot(runtime, record.projectPath);
      resource = {
        scope: "project",
        kind: record.kind,
        launchId: record.launch_id!,
        project,
        directory,
        ...(record.source_head ? { sourceHead: record.source_head } : {}),
        lease: {
          path: directory.path,
          pathKey: directory.pathKey,
          leaseId: record.lease_id,
          leaseHolder: record.lease_holder,
        },
        ...(record.kind === "scout" && record.report_path
          ? { reportSourcePath: record.report_path }
          : {}),
      };
    } else {
      if (record.kind !== "scout" || !record.report_path)
        throw new HostFailure(
          "INVALID_REQUEST",
          "Legacy independent scout requires its existing archive path.",
        );
      resource = {
        scope: "independent",
        kind: "scout",
        launchId: record.launch_id!,
        directory,
        reportSourcePath: record.report_path,
      };
    }
    await verifyResource(runtime, resource);
    const previous = current.ledger.workers[record.launch_id!];
    if (previous && JSON.stringify(previous.resource) !== JSON.stringify(resource))
      throw new HostFailure(
        "LEASE_MISMATCH",
        "Legacy launch already has different ledger ownership.",
      );
    current.ledger.workers[record.launch_id!] ??= {
      resource,
      binding: verifiedBinding,
      archiveOwned: record.kind === "scout",
      ...(record.delivery_base ? { legacyDeliveryBase: record.delivery_base } : {}),
    };
    await current.save();
    return resource;
  });
}
