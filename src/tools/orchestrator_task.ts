import type { ToolOutcome } from "../core/tool";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  NAME,
  errorMessage,
  text,
  type IndependentTaskParams,
  type ProjectTaskParams,
  type TaskItem,
  type TaskParams,
  type ToolFactory,
  type WorkerRecord,
} from "../runtime/shared";
import type { ConfigurationContext, ExecutionTarget, HostPath } from "../runtime/execution";
import { agentName } from "../runtime/execution";
import { canonicalPath } from "../runtime/host-paths";
import type { HostArgs, HostResult } from "../runtime/helper-protocol";
import { effectiveWorkerChoice, selectedModels, type SelectedOmpContext } from "../runtime/omp";
import {
  callMachine,
  checkMachine,
  machineError,
  resolveMachine,
  type ResolvedMachine,
} from "../runtime/machines";
import type { ControllerOperation } from "../runtime/store";
import projectsTool, { readProjects, validateName } from "./projects";
import {
  agentBinding,
  createTab,
  getAgent,
  promptAgent,
  startAgent,
  CLAUDE_EFFORTS,
  CLAUDE_MODEL,
  type AgentChoice,
  waitForShell,
} from "../runtime/herdr";
import { projectSpace, researchSpace, serializeSpaces, workerLabel } from "../runtime/spaces";
import {
  adoptWorker,
  handleSession,
  hasWorker,
  persist,
  publicRecord,
  requireOwnership,
  resumeWorkers,
  stateFor,
  watchWorker,
  type WorkerState,
} from "./workers";

export type LaunchParams = ProjectTaskParams | (IndependentTaskParams & { machine?: string });
export type LaunchPreflight = {
  target: ExecutionTarget;
  resolved: ResolvedMachine;
  selected: SelectedOmpContext;
  forbiddenRoots: HostPath[];
  choices: Record<string, AgentChoice>;
} & (
  | { scope: "independent" }
  | {
      scope: "project";
      project: string;
      projectPath: string;
      projectPathKey: string;
      head: string;
      branch?: string;
      localChanges: string;
      starts: Record<string, string>;
      originWarnings: Record<string, string>;
    }
);

export async function runTask(
  state: WorkerState,
  root: string,
  params: LaunchParams,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  state.active = true;
  try {
    // The agent loop validates Zod params, but custom-tool adapters forward them unchanged;
    // retain this guard for direct callers and semantic invariants not covered by the schema.
    validateTask(params);
    if (!("scope" in params)) {
      // OMP's strict tool schema transport materializes omitted optional fields as "" or false; keep omission as default behavior.
      params = {
        ...params,
        tasks: params.tasks.map(({ agent, pushTo, role, model, startFrom, hold, ...item }) => ({
          ...item,
          ...(agent === "claude" ? { agent } : {}),
          ...(pushTo ? { pushTo } : {}),
          ...(role ? { role } : {}),
          ...(model ? { model } : {}),
          ...(startFrom ? { startFrom } : {}),
          ...(hold ? { hold } : {}),
        })),
      };
    }
    requireOwnership(state);
    await resumeWorkers(state);
    const active = params.tasks.find((item) => hasWorker(state, item.name));
    if (active) throw new Error(`Worker name already retained: ${active.name}`);
    const preflight = await preflightTask(state, root, params, signal);
    const collision = params.tasks.find((item) => hasWorker(state, item.name));
    if (collision) throw new Error(`Worker name already retained: ${collision.name}`);
    // Reserve the entire batch before any launch can yield to a competing call.
    const records = params.tasks.map((item) =>
      workerRecord(state, preflight, item, randomUUID(), root, params.context),
    );
    for (const record of records) adoptWorker(state, record, "starting");
    const launched = await Promise.all(
      params.tasks.map((item, index) =>
        launchWorker(state, preflight, params.context, item, records[index]!, signal),
      ),
    );
    return text(`Visible workers launched:\n${JSON.stringify(launched, null, 2)}`, launched);
  } catch (error) {
    return text(errorMessage(error), undefined, true);
  }
}

/** Claude Code resolves aliases itself; omitting the model keeps the host's default. */
function claudeChoice(model: string | undefined): AgentChoice {
  if (!model) return {};
  const split = model.lastIndexOf(":");
  return split > 0 ? { model: model.slice(0, split), thinking: model.slice(split + 1) } : { model };
}

function validateTask(params: TaskParams): void {
  if (!params || typeof params !== "object") throw new Error("Malformed task scope");
  const hasProject = Object.prototype.hasOwnProperty.call(params, "project");
  const hasScope = Object.prototype.hasOwnProperty.call(params, "scope");
  if (hasProject === hasScope)
    throw new Error("Task must set exactly one project or independent scope");
  const independent = hasScope;
  if (independent) {
    if ((params as IndependentTaskParams).scope !== "independent")
      throw new Error("Invalid task scope");
  } else if (
    typeof (params as ProjectTaskParams).project !== "string" ||
    Object.prototype.hasOwnProperty.call(params, "machine") ||
    !NAME.test((params as ProjectTaskParams).project)
  ) {
    throw new Error("Invalid registered project name");
  }
  if (typeof params.context !== "string") throw new Error("Task context must be a string");
  if (!Array.isArray(params.tasks) || params.tasks.length < 1 || params.tasks.length > 32)
    throw new Error("Tasks must contain 1 to 32 items");
  const names = new Set<string>();
  for (const item of params.tasks) {
    validateName(item.name, "worker");
    if (names.has(item.name)) throw new Error(`Duplicate worker name: ${item.name}`);
    names.add(item.name);
    if (item.kind !== "implementation" && item.kind !== "scout")
      throw new Error(`Invalid task kind for ${item.name}: ${item.kind}`);
    if (typeof item.task !== "string" || !item.task.trim())
      throw new Error(`Task for ${item.name} must be non-empty`);
    if (item.agent !== undefined && item.agent !== "omp" && item.agent !== "claude")
      throw new Error(`Invalid agent for ${item.name}: ${item.agent}`);
    if (item.agent === "claude" && item.role)
      throw new Error(`Claude Code worker ${item.name} takes a model, not an OMP role`);
    if (item.agent === "claude" && item.model && !CLAUDE_MODEL.test(item.model))
      throw new Error(
        `Invalid Claude Code model for ${item.name}: ${item.model}; use an alias or full name with optional :${CLAUDE_EFFORTS.join("|")}`,
      );
    if (item.remoteControl !== undefined && typeof item.remoteControl !== "boolean")
      throw new Error(`Invalid remoteControl for ${item.name}`);
    if (item.remoteControl && item.agent !== "claude")
      throw new Error(`Remote Control needs a Claude Code worker: ${item.name}`);
    if (item.role !== undefined && (typeof item.role !== "string" || !NAME.test(item.role)))
      throw new Error(`Invalid OMP model role for ${item.name}: ${item.role}`);
    if (item.model !== undefined && (typeof item.model !== "string" || !/^\S+$/.test(item.model)))
      throw new Error(`Invalid OMP model for ${item.name}: ${item.model}`);
    if (item.role !== undefined && item.model !== undefined)
      throw new Error(`Task ${item.name} can set role or model, not both`);
    if (item.thinking !== undefined)
      throw new Error(`Set thinking for ${item.name} with a :level suffix on model`);
    if (independent && item.kind !== "scout")
      throw new Error("Independent scope accepts scout tasks only");
    if (independent && item.hold !== undefined)
      throw new Error(`Independent scout ${item.name} cannot set hold`);
    if (independent && item.pushTo !== undefined)
      throw new Error(`Independent scout ${item.name} cannot set pushTo`);
    if (!independent && item.kind === "scout" && item.pushTo !== undefined)
      throw new Error(`Scout task ${item.name} cannot set pushTo`);
    if (
      !independent &&
      item.pushTo !== undefined &&
      (typeof item.pushTo !== "string" || !item.pushTo.trim())
    )
      throw new Error(`pushTo for ${item.name} must be non-empty`);
    if (independent && item.startFrom !== undefined)
      throw new Error(`Independent scout ${item.name} cannot set startFrom`);
    if (
      item.startFrom !== undefined &&
      (typeof item.startFrom !== "string" || !item.startFrom.trim())
    )
      throw new Error(`startFrom for ${item.name} must be non-empty`);
    if (item.hold !== undefined && typeof item.hold !== "boolean")
      throw new Error(`hold for ${item.name} must be a boolean`);
    if (item.hold && item.kind !== "implementation")
      throw new Error(`Only implementation tasks can set hold: ${item.name}`);
  }
}

export async function preflightTask(
  state: WorkerState,
  root: string,
  params: LaunchParams,
  signal?: AbortSignal,
): Promise<LaunchPreflight> {
  const registry = await readProjects(root, signal);
  const entry =
    "project" in params && Object.hasOwn(registry.projects, params.project)
      ? registry.projects[params.project]
      : undefined;
  if ("project" in params && !entry)
    throw new Error(`Unknown registered project: ${params.project}`);
  const saved = state.store.independentTarget;
  const override = "scope" in params ? params.machine || undefined : undefined;
  const selector = entry?.machine ?? (override || saved.machineId);
  const binding = entry?.binding
    ? { machineId: entry.machine, ...entry.binding }
    : !entry && !override && "sshTarget" in saved
      ? saved
      : undefined;
  const options = { controllerId: state.store.controllerId, binding, signal };
  const agents = [...new Set(params.tasks.map((item) => item.agent ?? "omp"))];
  // OMP-only batches keep the original preflight arguments that older helpers accept.
  const agentArgs = agents.includes("claude") ? { agents } : {};
  const checked = await checkMachine(state.api, selector, {
    ...options,
    preflight: entry
      ? { scope: "project", projectPath: entry.path, ...agentArgs }
      : { scope: "independent", ...agentArgs },
  });
  if (!checked.ready || !checked.target || !checked.preflight)
    throw new Error(
      checked.errors
        .map((error) => `${error.message}${error.remedy ? ` ${error.remedy}` : ""}`)
        .join("; "),
    );
  await requireHerdr(state, checked.target);
  const target = checked.target;
  const resolved = await resolveMachine(state.api, target.machineId, options);
  if (resolved.host.hostId !== target.hostId) throw new Error("Host changed during preflight");
  const context = { ...checked.preflight.context, ...(entry ? { cwd: entry.path } : {}) };
  const selected: SelectedOmpContext = {
    machine: target.machineId,
    session: target.session,
    os: target.os,
    configuration_context: context,
    resolved: {
      target,
      context,
      controllerId: state.store.controllerId,
      runtime: resolved.runtime,
    },
  };
  const models = agents.includes("omp")
    ? await selectedModels(state.api, selected, signal)
    : undefined;
  const choices: Record<string, AgentChoice> = {};
  for (const item of params.tasks)
    choices[item.name] = models
      ? item.agent === "claude"
        ? claudeChoice(item.model)
        : await effectiveWorkerChoice(models, context, item, signal)
      : claudeChoice(item.model);
  const forbiddenRoots: HostPath[] = [];
  for (const [name, registered] of Object.entries(registry.projects)) {
    if (
      registered.machine !== target.machineId &&
      !(registered.binding && registered.binding.hostId === target.hostId)
    )
      continue;
    try {
      const validated = await callMachine(
        state.api,
        resolved,
        "path.validate",
        { path: registered.path, kind: registered === entry ? "git_root" : "forbidden_root" },
        options,
      );
      forbiddenRoots.push(validated.path);
    } catch (error) {
      throw new Error(`Cannot validate registered project ${name}: ${errorMessage(error)}`);
    }
  }
  if (target.kind === "local") {
    forbiddenRoots.push(await canonicalPath(root));
  }
  const common = { target, resolved, selected, forbiddenRoots, choices };
  if (!entry || !("project" in params)) return { ...common, scope: "independent" };
  const snapshot = await callMachine(
    state.api,
    resolved,
    "project.snapshot",
    {
      projectPath: entry.path,
      tasks: params.tasks.map(({ name, kind, startFrom, pushTo }) => ({
        name,
        kind,
        ...(startFrom ? { startFrom } : {}),
        ...(pushTo ? { pushTo } : {}),
      })),
    },
    options,
  );
  if (entry.pathKey && entry.pathKey !== snapshot.project.pathKey)
    throw new Error("Registered project identity changed during preflight.");
  if (!entry.pathKey) {
    // Reuse the registry writer's lock and atomic migration instead of a second write convention.
    const result = await projectsTool(state.api).execute(
      { op: "add", name: params.project, path: snapshot.project.path, machine: "local" },
      signal,
    );
    if (result.isError)
      throw new Error(result.content.map((part) => ("text" in part ? part.text : "")).join("\n"));
  }
  return {
    ...common,
    scope: "project",
    project: params.project,
    projectPath: snapshot.project.path,
    projectPathKey: snapshot.project.pathKey,
    head: snapshot.head,
    branch: snapshot.branch,
    localChanges: snapshot.excludedChanges,
    starts: snapshot.starts,
    originWarnings: snapshot.originWarnings,
  };
}

async function requireHerdr(state: WorkerState, target: ExecutionTarget): Promise<void> {
  if (
    target.kind === "local" &&
    (state.env.HERDR_ENV !== "1" || !state.env.HERDR_SOCKET_PATH || !state.env.HERDR_PANE_ID)
  )
    throw new Error(
      "The root session must run inside a Herdr pane with Herdr's integration for its agent installed",
    );
}

/**
 * Builds the assignment each worker receives. Workers run unattended, so every prompt states the
 * observable finish line and what is safe to do without asking, instead of a step-by-step recipe.
 */
function workerPrompt(
  preflight: LaunchPreflight,
  context: string,
  item: TaskItem,
  directory: string,
  reportPath: string | undefined,
): string {
  const lead = context ? `${context}\n\n` : "";
  if (item.kind === "implementation")
    return `${lead}You are an unattended worker in an isolated worktree created for this assignment. You are done when the change works: implement it, run or exercise the changed behavior and the relevant local checks, fix failures your change causes, and commit every assignment change. Keep going until then rather than stopping for review; the worktree and its local checks are disposable, so run, fix, and rerun them without asking. Ask only when a missing decision would materially change the outcome, and mention optional extras as follow-ups instead of adding them. Work directly without delegating to subagents.\n\n${item.task}`;
  // Claude Code cannot parse long shell heredocs for its permission check and stops to ask in
  // an unattended tab; its Write tool is allowed outside the worktree without asking.
  const writer =
    item.agent === "claude" ? " Write the report with the Write tool, not a shell command." : "";
  const finish = `You are done when the authoritative, non-empty standalone Markdown report is at ${reportPath} and your final message states the concise conclusion.${writer} Record whatever helps the reader (investigation, findings, evidence, recommendations, unresolved decisions) without fixed headings; unresolved decisions go in the report and do not block completion. Work directly without delegating to subagents.`;
  if (preflight.scope === "project") {
    const revision = preflight.starts[item.name] ?? preflight.head;
    const excluded = preflight.localChanges
      ? ` Disclose these excluded local changes in the report:\n${preflight.localChanges}`
      : " The registered checkout has no local changes to exclude.";
    return `${lead}You are a scout researching the exact committed revision ${revision} of this project. The registered checkout's local changes are excluded.${excluded}\nThis worktree is disposable: scratch edits, experiments, and commits are fine and are never delivered.\n\n${finish}\n\n${item.task}`;
  }
  return `${lead}You are a project-independent scout. No registered-project checkout or project revision applies, and project-specific context is intentionally excluded; global and user agent instructions still apply. Scratch files in ${directory} are disposable and never delivered; do not create commits or implement changes for delivery. Public web search and public URL reads are enabled. Use authenticated external systems only when this assignment explicitly asks for them.\n\n${finish} Include source URLs and the research date in the report.\n\n${item.task}`;
}

export function prepareLaunchOperation(
  state: WorkerState,
  record: WorkerRecord,
  channel: ControllerOperation["channel"],
  operation: string,
  request: unknown,
): ControllerOperation {
  const now = new Date().toISOString();
  const intent: ControllerOperation = {
    id: randomUUID(),
    launchId: record.launch_id!,
    workerName: record.name,
    channel,
    operation,
    requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    state: "prepared",
    createdAt: now,
    updatedAt: now,
  };
  state.store.saveOperation(intent);
  return intent;
}

export async function runLaunchOperation<T>(
  state: WorkerState,
  intent: ControllerOperation,
  invoke: (id: string) => Promise<T>,
  acquired?: (result: T) => void,
  attempt = 0,
): Promise<T> {
  intent.state = "sent";
  intent.updatedAt = new Date().toISOString();
  state.store.saveOperation(intent);
  try {
    const result = await invoke(intent.id);
    acquired?.(result);
    intent.state = "confirmed";
    intent.response = result;
    intent.updatedAt = new Date().toISOString();
    state.store.saveOperation(intent);
    return result;
  } catch (error) {
    const detail = machineError(error, intent.channel);
    // An untyped exception after dispatch is not proof that a mutation had no effect.
    if (!(error && typeof error === "object" && ("detail" in error || "effect" in error))) {
      detail.effect = "unknown";
      detail.retry = "reconcile";
    }
    intent.state = detail.effect === "none" ? "refused" : "uncertain";
    intent.error = {
      code: detail.code,
      message: detail.message,
      channel: detail.channel,
      effect: detail.effect,
      retry: detail.retry,
      operationId: intent.id,
      ...(detail.remedy ? { remedy: detail.remedy } : {}),
    };
    intent.updatedAt = new Date().toISOString();
    state.store.saveOperation(intent);
    if (
      intent.channel === "helper" &&
      detail.code === "LOCK_BUSY" &&
      detail.effect === "none" &&
      attempt < 2
    ) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50 * (attempt + 1));
      await promise;
      return runLaunchOperation(state, intent, invoke, acquired, attempt + 1);
    }
    throw error;
  }
}

async function launchWorker(
  state: WorkerState,
  preflight: LaunchPreflight,
  context: string,
  item: TaskItem,
  record: WorkerRecord,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const target = preflight.target;
  const launchId = record.launch_id!;
  const options = { controllerId: state.store.controllerId, signal };
  const hostMutation = <Op extends "worker.allocate" | "worker.bind-agent" | "worker.release">(
    op: Op,
    args: HostArgs[Op],
    acquired?: (result: HostResult<Op>) => void,
  ) =>
    serializeSpaces(state, target, () =>
      runLaunchOperation(
        state,
        prepareLaunchOperation(state, record, "helper", op, args),
        (operationId) =>
          callMachine(state.api, preflight.resolved, op, args, { ...options, operationId }),
        acquired,
      ),
    );
  let allocated = false;
  let topologyAttempted = false;
  try {
    try {
      await getAgent(state.deps, target, record.agent_name, { signal });
      throw new Error("Controller-qualified agent alias is already in use");
    } catch (error) {
      const detail = machineError(error, "herdr");
      if (detail.code !== "RESOURCE_NOT_FOUND") throw error;
    }
    record.phase = "allocating";
    persist(state, record);
    const resource = await hostMutation(
      "worker.allocate",
      {
        launchId,
        kind: item.kind,
        scope: preflight.scope,
        ...(preflight.scope === "project"
          ? {
              projectPath: preflight.projectPath,
              sourceHead: record.source_head!,
            }
          : {}),
        forbiddenRoots: preflight.forbiddenRoots,
      } as HostArgs["worker.allocate"],
      (resource) => {
        allocated = true;
        if (resource.scope === "project") {
          record.worktree = resource.directory.path;
          record.lease_id = resource.lease.leaseId;
          record.lease_holder = resource.lease.leaseHolder;
        } else record.working_directory = resource.directory.path;
        record.report_source_path = resource.reportSourcePath;
        persist(state, record);
      },
    );
    const directory = resource.directory.path;
    const configuration: ConfigurationContext = {
      ...preflight.selected.configuration_context,
      cwd: directory,
    };
    const kind = record.agent_kind ?? "omp";
    let choice: AgentChoice = preflight.choices[item.name]!;
    if (kind === "omp") {
      const models = await selectedModels(
        state.api,
        { ...preflight.selected, configuration_context: configuration },
        signal,
      );
      choice = await effectiveWorkerChoice(models, configuration, item, signal);
      record.configuration_context = models.context;
    }
    record.model = choice.model;
    record.thinking = choice.thinking;
    if (record.remote_control) choice = { ...choice, remoteControl: record.name };
    record.prompt = workerPrompt(preflight, context, item, directory, record.report_source_path);
    persist(state, record);
    if (record.report_path) await mkdir(dirname(record.report_path), { recursive: true });
    record.phase = "opening_space";
    persist(state, record);
    topologyAttempted = true;
    const label = workerLabel(item.kind, item.name);
    let workspace: string | undefined;
    if (preflight.scope === "independent") {
      workspace = await runLaunchOperation(
        state,
        prepareLaunchOperation(state, record, "herdr", "research.open", {
          target,
          directory: target.neutralRoot,
          label: "research",
        }),
        () => researchSpace(state, target, { signal }),
        (id) => {
          record.workspace_id = id;
          persist(state, record);
        },
      );
    }
    await runLaunchOperation(
      state,
      prepareLaunchOperation(state, record, "herdr", "worker.open", {
        target,
        directory,
        workspace,
        label,
      }),
      async () =>
        preflight.scope === "project"
          ? projectSpace(
              state,
              target,
              preflight.project,
              preflight.projectPath,
              directory,
              label,
              { signal },
            )
          : {
              workspaceId: workspace!,
              ...(await createTab(state.deps, target, workspace!, directory, label, { signal })),
            },
      (space) => {
        record.workspace_id = space.workspaceId;
        record.tab_id = space.tabId;
        record.pane_id = space.paneId;
        persist(state, record);
      },
    );
    await waitForShell(state.deps, target, record.pane_id!, { signal });
    record.phase = "starting_agent";
    persist(state, record);
    await runLaunchOperation(
      state,
      prepareLaunchOperation(state, record, "herdr", "agent.start", {
        target,
        alias: record.agent_name,
        pane: record.pane_id,
        directory,
        choice,
      }),
      () =>
        startAgent(
          state.deps,
          target,
          kind,
          record.agent_name!,
          record.pane_id!,
          directory,
          choice,
          { signal },
        ),
    );
    const agent = await getAgent(state.deps, target, record.pane_id, { signal });
    // Agents expose a future session filename before creating it. Bind terminal ownership now;
    // S7 must confirm a materialized session reference in a later revision before helper reads.
    record.agent_binding = agentBinding(
      target,
      { ...agent, sessionPath: undefined },
      resource.directory,
      {
        name: record.agent_name!,
        paneId: record.pane_id!,
        tabId: record.tab_id!,
        workspaceId: record.workspace_id!,
      },
      1,
      kind,
    );
    persist(state, record);
    await hostMutation("worker.bind-agent", { launchId, binding: record.agent_binding });
    record.phase = "submitting_prompt";
    persist(state, record);
    await runLaunchOperation(
      state,
      prepareLaunchOperation(state, record, "herdr", "agent.prompt", {
        target,
        binding: record.agent_binding,
        prompt: record.prompt,
      }),
      () => promptAgent(state.deps, target, record.pane_id, record.prompt!, { signal, kind }),
    );
    const observed = await getAgent(state.deps, target, record.pane_id, { signal });
    agentBinding(
      target,
      observed,
      resource.directory,
      {
        name: record.agent_name!,
        paneId: record.pane_id!,
        tabId: record.tab_id!,
        workspaceId: record.workspace_id!,
      },
      1,
      kind,
    );
    // An idle startup is not completion evidence; supervision reconciles without replaying.
    if (observed.status === "working" || observed.status === "blocked") {
      record.status = observed.status === "blocked" ? "blocked" : "working";
      record.phase = "running";
      adoptWorker(state, record, observed.status);
    } else {
      persist(state, record);
      watchWorker(state, record);
    }
  } catch (error) {
    record.error = errorMessage(error);
    const operations = state.store.operations({ name: record.name, launchId: record.launch_id });
    const uncertain = operations.some((op) => op.state === "uncertain");
    if (!topologyAttempted && !uncertain) {
      try {
        if (allocated)
          await hostMutation("worker.release", {
            launchId,
            proof: "discard",
            herdrClosed: true,
            ...(record.lease_id
              ? { leaseId: record.lease_id, leaseHolder: record.lease_holder }
              : {}),
          });
        state.records.delete(record.name);
        state.store.delete(record.name);
        return { ...launchResult(record, preflight), status: "failed" };
      } catch (cleanupError) {
        record.error += `; unused resource release failed: ${errorMessage(cleanupError)}`;
      }
    }
    persist(state, record);
    watchWorker(state, record);
  }
  return launchResult(record, preflight);
}

export function workerRecord(
  state: WorkerState,
  preflight: LaunchPreflight,
  item: TaskItem,
  launchId: string,
  root: string,
  context: string,
): WorkerRecord {
  return {
    scope: preflight.scope,
    kind: item.kind,
    name: item.name,
    ...(item.agent === "claude" ? { agent_kind: "claude" as const } : {}),
    ...(item.remoteControl ? { remote_control: true } : {}),
    role: item.role,
    controller_id: state.store.controllerId,
    launch_id: launchId,
    target: preflight.target,
    agent_name: agentName(state.store.controllerId, launchId),
    status: "starting",
    phase: "preflighted",
    generation: 0,
    worker_config_path: preflight.target.workerConfig.path,
    worker_config_sha256: preflight.target.workerConfig.sha256,
    configuration_context: preflight.selected.configuration_context,
    ...preflight.choices[item.name],
    // The original assignment survives a crash before the cwd-specific prompt can be built.
    prompt: context ? `${context}\n\n${item.task}` : item.task,
    ...(preflight.scope === "project"
      ? {
          project: preflight.project,
          projectPath: preflight.projectPath,
          project_path_key: preflight.projectPathKey,
          source_head: preflight.starts[item.name],
          delivery_base: preflight.starts[item.name],
          branch: preflight.branch,
          start_from: item.startFrom,
          push_to: item.pushTo,
          hold: item.hold,
          local_changes: item.kind === "scout" ? preflight.localChanges : undefined,
        }
      : {}),
    report_path:
      item.kind === "scout"
        ? join(
            root,
            ".omp",
            "reports",
            preflight.scope === "project" ? preflight.project : "_independent",
            `${launchId}-${item.name}.md`,
          )
        : undefined,
  };
}

function launchResult(record: WorkerRecord, preflight: LaunchPreflight): Record<string, unknown> {
  return {
    ...publicRecord(record),
    machine: preflight.target.machineId,
    session: preflight.target.session,
    phase: record.phase,
    launch_id: record.launch_id,
    agent_name: record.agent_name,
    source_head: record.source_head,
    report_source_path: record.report_source_path,
    ...(preflight.scope === "project" && preflight.originWarnings[record.name]
      ? { origin_warning: preflight.originWarnings[record.name] }
      : {}),
  };
}

const taskTool: ToolFactory = (pi) => {
  const state = stateFor(pi);
  const z = pi.zod;

  return {
    name: "orchestrator_task",
    label: "Orchestrator task",
    approval: "exec",
    description:
      "Launch visible workers for one scope and machine per call. agent picks OMP (default) or claude (Claude Code, local machine only; model is an optional Claude Code alias or full name with optional :effort low|medium|high|xhigh|max; no role; remoteControl starts it as a Claude Code Remote Control session named after the worker so the user can follow it from claude.ai or the Claude app). Project workers use the registration's machine with no override; independent scouts use the saved default or optional machine. Role selects from that host's OMP catalog; model selects an exact provider/id with optional :level thinking (not both). startFrom names a committed branch on the project's host. Default delivery stays in that host's registered checkout; pushTo is explicit publication instead. hold stops for review. origin_warning discloses a source behind its upstream. Partial starts retain phase and operation evidence without replaying prompts. Supervision and settlement use each worker's original machine; completions wake this session after delivery or verified local report collection.",
    parameters: z.union([
      z
        .object({
          project: z.string(),
          context: z.string(),
          tasks: z
            .array(
              z.union([
                z
                  .object({
                    kind: z.literal("implementation"),
                    name: z.string(),
                    task: z.string(),
                    agent: z.enum(["omp", "claude"]).optional(),
                    remoteControl: z.boolean().optional(),
                    role: z.string().optional(),
                    model: z.string().optional(),
                    pushTo: z.string().optional(),
                    startFrom: z.string().optional(),
                    hold: z.boolean().optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("scout"),
                    name: z.string(),
                    task: z.string(),
                    agent: z.enum(["omp", "claude"]).optional(),
                    remoteControl: z.boolean().optional(),
                    role: z.string().optional(),
                    model: z.string().optional(),
                    startFrom: z.string().optional(),
                  })
                  .strict(),
              ]),
            )
            .min(1)
            .max(32),
        })
        .strict(),
      z
        .object({
          scope: z.literal("independent"),
          machine: z.string().optional(),
          context: z.string(),
          tasks: z
            .array(
              z
                .object({
                  kind: z.literal("scout"),
                  name: z.string(),
                  task: z.string(),
                  agent: z.enum(["omp", "claude"]).optional(),
                  remoteControl: z.boolean().optional(),
                  role: z.string().optional(),
                  model: z.string().optional(),
                })
                .strict(),
            )
            .min(1)
            .max(32),
        })
        .strict(),
    ]),
    execute: async (params, signal) => runTask(state, pi.cwd, params as TaskParams, signal),
    onSession: (reason) => handleSession(state, reason),
  };
};

export default taskTool;
