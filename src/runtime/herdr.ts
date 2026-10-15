import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  targetKey,
  validateExecutionTarget,
  type ExecutionTarget,
  type HostPath,
} from "./execution";
import type { AgentBinding, HostError, ToolCheck } from "./helper-protocol";
import { stringAt, valueAt, type RuntimeDeps, type WorkerRecord } from "./shared";

export type HerdrAgent = {
  identity: string;
  status: string;
  name?: string;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  cwd?: string;
  sessionPath?: string;
  incarnation?: string;
  completionSeq?: number;
  stateChangeSeq?: number;
  interactiveReady?: boolean;
};
export type HerdrTab = { tabId: string; paneId: string };
export type HerdrSpace = HerdrTab & { workspaceId: string };
export type HerdrWorkspace = {
  workspaceId: string;
  label: string;
  repoRoot?: string;
  checkoutPath?: string;
  linked: boolean;
};
export type HerdrOptions = { signal?: AbortSignal };
export type AgentKind = AgentBinding["identity"];
export const AGENT_KINDS: readonly AgentKind[] = ["omp", "claude"];
export type HerdrIntegrationEvidence = { targetKey: string; check: ToolCheck };
export type HerdrPreflight = { session: string; version: string; protocol: number };

export class HerdrError extends Error implements HostError {
  readonly channel = "herdr" as const;
  constructor(
    readonly code: HostError["code"],
    message: string,
    readonly effect: HostError["effect"] = "none",
    readonly retry: HostError["retry"] = "user_action",
    readonly remedy?: string,
    readonly herdrCode?: string,
  ) {
    super(message.slice(0, 4096));
    this.name = "HerdrError";
  }
  toJSON(): HostError {
    return {
      code: this.code,
      message: this.message,
      channel: this.channel,
      effect: this.effect,
      retry: this.retry,
      ...(this.remedy ? { remedy: this.remedy } : {}),
    };
  }
}

function json(output: string, mutation = false): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new HerdrError(
      "PROTOCOL_MISMATCH",
      "Herdr returned invalid JSON",
      mutation ? "unknown" : "none",
      mutation ? "reconcile" : "user_action",
    );
  }
}

function serverSession(status: unknown): string {
  const session = valueAt(status, ["session"]);
  if (session === null) return "default";
  if (typeof session === "string" && session) return session;
  throw new HerdrError("PROTOCOL_MISMATCH", "Herdr status did not identify its session");
}

function structuredError(output: string): string | undefined {
  try {
    const code = stringAt(JSON.parse(output), ["error", "code"]);
    return code && /^[a-z0-9_]{1,80}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function commandError(rawCode: string | undefined, mutation: boolean, killed = false): HerdrError {
  const codes: Record<string, HostError["code"]> = {
    unknown_machine: "MACHINE_NOT_FOUND",
    machine_not_found: "MACHINE_NOT_FOUND",
    machine_disabled: "MACHINE_DISABLED",
    unknown_method: "CAPABILITY_MISSING",
    method_not_found: "CAPABILITY_MISSING",
    incompatible_protocol: "PROTOCOL_MISMATCH",
    agent_not_found: "RESOURCE_NOT_FOUND",
    pane_not_found: "RESOURCE_NOT_FOUND",
    workspace_not_found: "RESOURCE_NOT_FOUND",
    tab_not_found: "RESOURCE_NOT_FOUND",
    agent_mismatch: "AGENT_MISMATCH",
    timeout: "TIMEOUT",
  };
  const code = rawCode
    ? (codes[rawCode] ?? "COMMAND_FAILED")
    : killed
      ? "TIMEOUT"
      : "TRANSPORT_OFFLINE";
  // A complete refusal proves no write only for errors whose semantics precede input/resource mutation.
  const refused =
    !!rawCode &&
    [
      "unknown_machine",
      "machine_not_found",
      "machine_disabled",
      "unknown_method",
      "method_not_found",
      "agent_not_found",
      "pane_not_found",
      "workspace_not_found",
      "tab_not_found",
      "agent_mismatch",
      "agent_blocked",
      "invalid_params",
    ].includes(rawCode);
  const uncertain = mutation && !refused;
  return new HerdrError(
    code,
    `Herdr ${rawCode ?? (killed ? "command deadline expired" : "connection or command failed")}`,
    uncertain ? "unknown" : "none",
    uncertain
      ? "reconcile"
      : code === "TRANSPORT_OFFLINE" || code === "TIMEOUT"
        ? "read_only"
        : "user_action",
    uncertain
      ? "Inspect the bound target before retrying; the operation may have executed."
      : undefined,
    rawCode,
  );
}

async function execute(
  deps: RuntimeDeps,
  args: string[],
  mutation: boolean,
  signal?: AbortSignal,
  timeout?: number,
): Promise<string> {
  let result;
  try {
    result = await deps.exec("herdr", args, { signal, ...(timeout ? { timeout } : {}) });
  } catch (error) {
    // Dependency exceptions can contain the full prompt or SSH diagnostics; do not expose them.
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      throw new HerdrError(
        "PREREQUISITE_MISSING",
        "Herdr executable is not available on the controller",
        "none",
        "user_action",
        "Install Herdr manually and make it available on PATH.",
      );
    throw commandError(undefined, mutation, signal?.aborted);
  }
  const code = structuredError(result.stderr.trim()) ?? structuredError(result.stdout.trim());
  if (result.code !== 0 || result.killed || code) throw commandError(code, mutation, result.killed);
  return result.stdout.trim();
}

function route(target: ExecutionTarget): string[] {
  try {
    validateExecutionTarget(target);
  } catch {
    throw new HerdrError("INVALID_REQUEST", "Herdr operation requires a resolved execution target");
  }
  return target.kind === "ssh" ? ["--machine", target.machineId] : ["--session", target.session];
}

async function command(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  args: string[],
  mutation: boolean,
  options: HerdrOptions = {},
  timeout = 40_000,
): Promise<string> {
  return execute(deps, [...route(target), ...args], mutation, options.signal, timeout);
}

// Native paths here are controller-local; remote overlay paths come only from ExecutionTarget.
export const WORKER_CONFIG = fileURLToPath(
  new URL("../../.omp/worker-config.yml", import.meta.url),
);
/** Approved Claude Code settings for unattended workers; local targets only. */
export const CLAUDE_WORKER_SETTINGS = fileURLToPath(
  new URL("../../.omp/claude-worker-settings.json", import.meta.url),
);
export async function resolveLocalHerdrTarget(
  deps: RuntimeDeps,
  paths: { runtimeRoot: string; neutralRoot: string; hostId: string },
  signal?: AbortSignal,
): Promise<ExecutionTarget> {
  const status = json(await execute(deps, ["status", "server", "--json"], false, signal, 10_000));
  return validateExecutionTarget({
    kind: "local",
    machineId: "local",
    hostId: paths.hostId,
    os: process.platform,
    arch: process.arch,
    pathStyle: process.platform === "win32" ? "win32" : "posix",
    session: serverSession(status),
    workerConfig: {
      path: WORKER_CONFIG,
      sha256: createHash("sha256")
        .update(await readFile(WORKER_CONFIG))
        .digest("hex"),
    },
    runtimeRoot: { path: paths.runtimeRoot, pathKey: paths.runtimeRoot },
    neutralRoot: { path: paths.neutralRoot, pathKey: paths.neutralRoot },
  });
}

export async function ensureIntegration(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  options: HerdrOptions & { integration?: HerdrIntegrationEvidence; agents?: AgentKind[] } = {},
): Promise<HerdrPreflight> {
  const agents = new Set(options.agents ?? ["omp"]);
  const status = json(await command(deps, target, ["status", "server", "--json"], false, options));
  const session = serverSession(status);
  if (session !== target.session)
    throw new HerdrError(
      "PROFILE_CHANGED",
      "Herdr server session differs from the bound execution target",
    );
  const version = stringAt(status, ["version"]) ?? "";
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  const baseline =
    parts &&
    (Number(parts[1]) > 0 ||
      Number(parts[2]) > 9 ||
      (Number(parts[2]) === 9 && Number(parts[3]) >= 3));
  if (
    valueAt(status, ["running"]) !== true ||
    valueAt(status, ["compatible"]) !== true ||
    valueAt(status, ["endpoint_compatible"]) !== true ||
    !baseline
  )
    throw new HerdrError(
      "PROTOCOL_MISMATCH",
      "Herdr requires a running compatible 0.9.3+ server",
      "none",
      "user_action",
      "Update Herdr manually; do not restart an occupied server automatically.",
    );
  // Endpoint generation 1 and private protocol 22 include the required topology/agent methods.
  // This is live server evidence, not the controller binary's bundled API schema.
  const protocol = valueAt(status, ["protocol"]);
  if (
    typeof protocol !== "number" ||
    protocol < 22 ||
    valueAt(status, ["capabilities", "endpoint_protocol_generation"]) !== 1 ||
    valueAt(status, ["capabilities", "health_check"]) !== true
  )
    throw new HerdrError(
      "CAPABILITY_MISSING",
      "Live Herdr server lacks required topology and agent protocol capabilities",
    );
  const snapshot = json(await command(deps, target, ["api", "snapshot"], false, options));
  if (
    !Array.isArray(valueAt(snapshot, ["result", "snapshot", "agents"])) ||
    !Array.isArray(valueAt(snapshot, ["result", "snapshot", "workspaces"]))
  )
    throw new HerdrError(
      "CAPABILITY_MISSING",
      "Live Herdr server did not expose agent and workspace state",
    );
  if (target.kind === "local") {
    const installed = await execute(deps, ["integration", "status"], false, options.signal, 10_000);
    const match = /^omp: (?:current|outdated) \(v(\d+)\)/m.exec(installed);
    if (agents.has("omp") && (!match || Number(match[1]) < 3))
      throw new HerdrError(
        "PREREQUISITE_MISSING",
        "Herdr OMP integration v3+ is required on the target",
        "none",
        "user_action",
        "Run herdr integration install omp on that host and restart OMP.",
      );
    // Herdr reports a Claude worker's transcript only through its Claude hook integration.
    if (agents.has("claude") && !/^claude: (?:current|outdated) \(v\d+\)/m.test(installed))
      throw new HerdrError(
        "PREREQUISITE_MISSING",
        "Herdr's Claude Code integration is required for Claude workers",
        "none",
        "user_action",
        "Run herdr integration install claude on this host.",
      );
  } else if (agents.has("claude"))
    throw new HerdrError(
      "PREREQUISITE_MISSING",
      "Claude Code workers currently run only on the local machine",
      "none",
      "user_action",
    );
  else {
    // Herdr does not forward installation inspection; the host preflight must supply it.
    const evidence = options.integration;
    if (
      !evidence ||
      evidence.targetKey !== targetKey(target) ||
      evidence.check.name !== "herdr-omp-integration" ||
      !evidence.check.available ||
      !/^\d+$/.test(evidence.check.version ?? "") ||
      Number(evidence.check.version) < 3
    )
      throw new HerdrError(
        "PREREQUISITE_MISSING",
        "Target-bound host preflight evidence for Herdr OMP integration v3+ is required",
        "none",
        "user_action",
        "Inspect herdr integration status on the target through host preflight.",
      );
  }
  return { session, version, protocol };
}

function paneRequired(pane: string | undefined): string {
  if (!pane) throw new HerdrError("INVALID_REQUEST", "Worker pane has not been allocated");
  return pane;
}
function numberAt(value: unknown, key: string): number | undefined {
  const number = valueAt(value, [key]);
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}
export async function getAgent(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  pane: string | undefined,
  options: HerdrOptions = {},
): Promise<HerdrAgent> {
  const value = json(
    await command(deps, target, ["agent", "get", paneRequired(pane)], false, options),
  );
  const agent = valueAt(value, ["result", "agent"]);
  if (!agent || typeof agent !== "object")
    throw new HerdrError("PROTOCOL_MISMATCH", "Herdr returned unrecognized agent state");
  const session = valueAt(agent, ["agent_session"]);
  const identity = stringAt(agent, ["agent"]) ?? "";
  // Herdr names Claude Code sessions only by ID; the host resolves the ID to its transcript.
  const sessionKind = identity === "claude" ? "id" : "path";
  return {
    identity,
    status: stringAt(agent, ["agent_status"]) ?? "",
    name: stringAt(agent, ["name"]),
    paneId: stringAt(agent, ["pane_id"]),
    tabId: stringAt(agent, ["tab_id"]),
    workspaceId: stringAt(agent, ["workspace_id"]),
    cwd: stringAt(agent, ["cwd"]),
    incarnation: stringAt(agent, ["terminal_id"]),
    sessionPath:
      stringAt(session, ["kind"]) === sessionKind ? stringAt(session, ["value"]) : undefined,
    completionSeq: numberAt(agent, "completion_seq"),
    stateChangeSeq: numberAt(agent, "state_change_seq"),
    interactiveReady:
      typeof valueAt(agent, ["interactive_ready"]) === "boolean"
        ? (valueAt(agent, ["interactive_ready"]) as boolean)
        : undefined,
  };
}

export function agentBinding(
  target: ExecutionTarget,
  agent: HerdrAgent,
  cwd: HostPath,
  expected: { name: string; paneId: string; tabId: string; workspaceId: string },
  revision: number,
  kind: AgentKind = "omp",
): AgentBinding {
  if (
    agent.identity !== kind ||
    agent.name !== expected.name ||
    agent.paneId !== expected.paneId ||
    agent.tabId !== expected.tabId ||
    agent.workspaceId !== expected.workspaceId ||
    agent.cwd !== cwd.path
  )
    throw new HerdrError(
      "AGENT_MISMATCH",
      "Observed agent does not match its allocated kind, terminal and directory",
    );
  return {
    revision,
    identity: kind,
    agentName: expected.name,
    session: target.session,
    paneId: expected.paneId,
    tabId: expected.tabId,
    workspaceId: expected.workspaceId,
    cwd,
    ...(agent.sessionPath ? { sessionPath: agent.sessionPath } : {}),
    ...(agent.incarnation ? { incarnation: agent.incarnation } : {}),
    ...(agent.completionSeq !== undefined ? { completionSeq: agent.completionSeq } : {}),
  };
}
function sameAgent(before: HerdrAgent, after: HerdrAgent): boolean {
  return (
    AGENT_KINDS.includes(before.identity as AgentKind) &&
    after.identity === before.identity &&
    !!before.name &&
    before.name === after.name &&
    !!before.paneId &&
    before.paneId === after.paneId &&
    !!before.incarnation &&
    before.incarnation === after.incarnation &&
    !!before.cwd &&
    before.cwd === after.cwd &&
    !!before.workspaceId &&
    before.workspaceId === after.workspaceId &&
    !!before.tabId &&
    before.tabId === after.tabId &&
    before.sessionPath === after.sessionPath
  );
}
export async function promptAgent(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  pane: string | undefined,
  message: string,
  options: HerdrOptions & { kind?: AgentKind } = {},
): Promise<void> {
  const address = paneRequired(pane);
  const before = await getAgent(deps, target, address, options);
  if (before.identity !== (options.kind ?? "omp"))
    throw new HerdrError("AGENT_MISMATCH", "Worker is not the expected agent");
  try {
    await command(
      deps,
      target,
      [
        "agent",
        "prompt",
        address,
        message,
        "--wait",
        "--until",
        "working",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        "30000",
      ],
      true,
      options,
    );
  } catch (error) {
    if (!(error instanceof HerdrError) || error.herdrCode !== "agent_prompt_stalled") throw error;
    let entered = false;
    try {
      const after = await getAgent(deps, target, address, options);
      if (!sameAgent(before, after))
        throw new HerdrError(
          "AGENT_MISMATCH",
          "Stalled prompt agent binding could not be proven",
          "unknown",
          "reconcile",
        );
      if (
        after.status === "working" ||
        after.status === "blocked" ||
        (before.completionSeq !== undefined &&
          after.completionSeq !== undefined &&
          after.completionSeq > before.completionSeq)
      )
        return;
      if (after.interactiveReady === false || !["idle", "done"].includes(after.status))
        throw new HerdrError(
          "OPERATION_UNCERTAIN",
          "Stalled prompt agent is not ready for Enter recovery",
          "unknown",
          "reconcile",
        );
      // Herdr already submitted the text; one Enter is the only permitted recovery input.
      await command(deps, target, ["agent", "send-keys", address, "enter"], true, options);
      entered = true;
      await command(
        deps,
        target,
        [
          "agent",
          "wait",
          address,
          "--until",
          "working",
          "--until",
          "done",
          "--until",
          "blocked",
          "--timeout",
          "5000",
        ],
        false,
        options,
        10_000,
      );
    } catch (recoveryError) {
      // The stalled response proves text was submitted, even when recovery observations fail.
      if (recoveryError instanceof HerdrError)
        throw new HerdrError(
          entered && recoveryError.code === "TIMEOUT" ? "OPERATION_UNCERTAIN" : recoveryError.code,
          recoveryError.message,
          "unknown",
          "reconcile",
          recoveryError.remedy,
          recoveryError.herdrCode,
        );
      throw new HerdrError(
        "OPERATION_UNCERTAIN",
        "Stalled prompt recovery could not be confirmed",
        "unknown",
        "reconcile",
      );
    }
  }
}
export function waitForAgent(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  pane: string | undefined,
  options: HerdrOptions = {},
  states: readonly string[] = ["idle", "done", "blocked"],
): Promise<string> {
  return command(
    deps,
    target,
    ["agent", "wait", paneRequired(pane), ...states.flatMap((state) => ["--until", state])],
    false,
    options,
    0,
  );
}
export function readAgent(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  pane: string | undefined,
  lines: number,
  options: HerdrOptions = {},
): Promise<string> {
  return command(
    deps,
    target,
    ["agent", "read", paneRequired(pane), "--source", "recent", "--lines", String(lines)],
    false,
    options,
  );
}
export async function interruptAgent(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  pane: string | undefined,
  options: HerdrOptions = {},
): Promise<void> {
  await command(deps, target, ["agent", "send-keys", paneRequired(pane), "esc"], true, options);
}
export async function listWorkspaces(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  options: HerdrOptions = {},
): Promise<HerdrWorkspace[]> {
  const value = json(await command(deps, target, ["workspace", "list"], false, options));
  const workspaces = valueAt(value, ["result", "workspaces"]);
  if (!Array.isArray(workspaces))
    throw new HerdrError("PROTOCOL_MISMATCH", "Herdr returned unrecognized workspaces");
  return workspaces.map((item) => {
    const workspaceId = stringAt(item, ["workspace_id"]);
    if (!workspaceId)
      throw new HerdrError("PROTOCOL_MISMATCH", "Herdr returned a workspace without an identifier");
    return {
      workspaceId,
      label: stringAt(item, ["label"]) ?? "",
      repoRoot: stringAt(item, ["worktree", "repo_root"]),
      checkoutPath: stringAt(item, ["worktree", "checkout_path"]),
      linked: valueAt(item, ["worktree", "is_linked_worktree"]) === true,
    };
  });
}
function spaceFrom(value: unknown): HerdrSpace {
  const workspaceId = stringAt(value, ["result", "workspace", "workspace_id"]);
  const tabId = stringAt(value, ["result", "tab", "tab_id"]);
  const paneId = stringAt(value, ["result", "root_pane", "pane_id"]);
  if (!workspaceId || !tabId || !paneId)
    throw new HerdrError(
      "PROTOCOL_MISMATCH",
      "Herdr creation returned unrecognized identifiers",
      "unknown",
      "reconcile",
    );
  return { workspaceId, tabId, paneId };
}
export async function createWorkspace(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  directory: string,
  label: string,
  options: HerdrOptions = {},
): Promise<HerdrSpace> {
  return spaceFrom(
    json(
      await command(
        deps,
        target,
        ["workspace", "create", "--cwd", directory, "--label", label, "--no-focus"],
        true,
        options,
      ),
      true,
    ),
  );
}
export async function openWorktree(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  repository: string,
  checkout: string,
  options: HerdrOptions = {},
): Promise<HerdrSpace> {
  // No label: opening a checkout must not rename an existing user-owned parent.
  const value = json(
    await command(
      deps,
      target,
      ["worktree", "open", "--cwd", repository, "--path", checkout, "--no-focus"],
      true,
      options,
    ),
    true,
  );
  if (valueAt(value, ["result", "already_open"]) === true)
    throw new HerdrError("AGENT_MISMATCH", `Worktree is already open in Herdr: ${checkout}`);
  return spaceFrom(value);
}
export function renameWorkspace(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  workspace: string,
  label: string,
  options: HerdrOptions = {},
): Promise<string> {
  return command(deps, target, ["workspace", "rename", workspace, label], true, options);
}
export async function createTab(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  workspace: string,
  directory: string,
  label: string,
  options: HerdrOptions = {},
): Promise<HerdrTab> {
  const value = json(
    await command(
      deps,
      target,
      [
        "tab",
        "create",
        "--workspace",
        workspace,
        "--cwd",
        directory,
        "--label",
        label,
        "--no-focus",
      ],
      true,
      options,
    ),
    true,
  );
  const tabId = stringAt(value, ["result", "tab", "tab_id"]);
  const paneId = stringAt(value, ["result", "root_pane", "pane_id"]);
  if (!tabId || !paneId)
    throw new HerdrError(
      "PROTOCOL_MISMATCH",
      "Herdr tab creation returned unrecognized identifiers",
      "unknown",
      "reconcile",
    );
  return { tabId, paneId };
}
export function waitForShell(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  pane: string,
  options: HerdrOptions = {},
): Promise<string> {
  // A nonblank rendered shell is portable across cmd, PowerShell, and custom Unix prompts.
  // agent start independently requires an available foreground shell and waits for OMP readiness.
  return command(
    deps,
    target,
    [
      "pane",
      "wait-output",
      pane,
      "--regex",
      "\\S",
      "--source",
      "visible",
      "--lines",
      "10",
      "--timeout",
      "5000",
    ],
    false,
    options,
    10_000,
  );
}
export function startOmpAgent(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  name: string,
  pane: string,
  directory: string,
  selection: { model: string; thinking?: string },
  options: HerdrOptions = {},
): Promise<string> {
  if (!selection.model || selection.model.startsWith("@") || !selection.model.includes("/"))
    throw new HerdrError(
      "MODEL_UNAVAILABLE",
      "Agent start requires a resolved exact provider/id model",
    );
  return command(
    deps,
    target,
    [
      "agent",
      "start",
      name,
      "--kind",
      "omp",
      "--pane",
      pane,
      "--",
      "--cwd",
      directory,
      `--config=${target.workerConfig.path}`,
      ...(target.ompProfile ? ["--profile", target.ompProfile] : []),
      "--model",
      selection.model,
      ...(selection.thinking ? ["--thinking", selection.thinking] : []),
    ],
    true,
    options,
  );
}
/** remoteControl names the Claude Code Remote Control session; OMP has no equivalent. */
export type AgentChoice = { model?: string; thinking?: string; remoteControl?: string };
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** A Claude Code alias or full model name with an optional `:effort`; Claude Code resolves it. */
export const CLAUDE_MODEL = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._\\[\\]-]*(?::(?:${CLAUDE_EFFORTS.join("|")}))?$`,
);
export function startClaudeAgent(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  name: string,
  pane: string,
  selection: AgentChoice,
  options: HerdrOptions = {},
): Promise<string> {
  if (target.kind !== "local")
    throw new HerdrError(
      "PREREQUISITE_MISSING",
      "Claude Code workers currently run only on the local machine",
      "none",
      "user_action",
    );
  if (selection.thinking && !(CLAUDE_EFFORTS as readonly string[]).includes(selection.thinking))
    throw new HerdrError("MODEL_UNAVAILABLE", `Unknown Claude Code effort: ${selection.thinking}`);
  // The pane already starts in the worker directory; Claude Code has no cwd flag.
  return command(
    deps,
    target,
    [
      "agent",
      "start",
      name,
      "--kind",
      "claude",
      "--pane",
      pane,
      "--",
      "--settings",
      CLAUDE_WORKER_SETTINGS,
      ...(selection.model ? ["--model", selection.model] : []),
      ...(selection.thinking ? ["--effort", selection.thinking] : []),
      ...(selection.remoteControl ? ["--remote-control", selection.remoteControl] : []),
    ],
    true,
    options,
  );
}
export function startAgent(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  kind: AgentKind,
  name: string,
  pane: string,
  directory: string,
  selection: AgentChoice,
  options: HerdrOptions = {},
): Promise<string> {
  if (kind === "claude") return startClaudeAgent(deps, target, name, pane, selection, options);
  return startOmpAgent(
    deps,
    target,
    name,
    pane,
    directory,
    { model: selection.model ?? "", thinking: selection.thinking },
    options,
  );
}
type WorkerSpace = Pick<WorkerRecord, "scope" | "workspace_id" | "tab_id">;
export async function closeWorkerSpace(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  worker: WorkerSpace,
  options: HerdrOptions = {},
): Promise<void> {
  const resource = worker.scope === "project" ? worker.workspace_id : worker.tab_id;
  if (!resource) throw new HerdrError("INVALID_REQUEST", "Worker space has not been allocated");
  // Even not-found is evidence only, not a cleanup receipt; S8 reconciles confirmed closure.
  await command(
    deps,
    target,
    [worker.scope === "project" ? "workspace" : "tab", "close", resource],
    true,
    options,
  );
}
export async function closeWorkerSpaceBestEffort(
  deps: RuntimeDeps,
  target: ExecutionTarget,
  worker: WorkerSpace,
  options: HerdrOptions = {},
): Promise<void> {
  try {
    await closeWorkerSpace(deps, target, worker, options);
  } catch (error) {
    deps.logger.warn?.("Visible worker cleanup failed", {
      channel: "herdr",
      target: targetKey(target),
      error: error instanceof HerdrError ? error.message : "Unexpected Herdr cleanup failure",
    });
  }
}
