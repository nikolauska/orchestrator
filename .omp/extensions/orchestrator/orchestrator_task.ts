import type { CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { mkdir, realpath, rm } from "node:fs/promises";
import {
  LEASE_ID,
  NAME,
  errorMessage,
  execCommand,
  text,
  type IndependentTaskParams,
  type Preflight,
  type ProjectTaskParams,
  type TaskItem,
  type TaskParams,
  type ToolFactory,
  type WorkerRecord,
} from "../../runtime/shared";
import { chatModels, resolveModel } from "../../runtime/omp";
import { readProjects, validateName } from "./projects";
import {
  branchHead,
  checkBranch,
  currentBranch,
  head,
  originForge,
  originLag,
  resetHard,
  status,
  topLevel,
  version as gitVersion,
} from "../../runtime/git";
import {
  closeWorkerSpace,
  createTab,
  ensureIntegration,
  getAgent,
  promptAgent,
  startOmpAgent,
  waitForShell,
  type HerdrSpace,
} from "../../runtime/herdr";
import { projectSpace, researchSpace, workerLabel } from "../../runtime/spaces";
import {
  acquireLease,
  returnLease,
  type TreehouseLease,
  version as treehouseVersion,
} from "../../runtime/treehouse";
import {
  adoptWorker,
  handleSession,
  hasWorker,
  persist,
  publicRecord,
  requireOwnership,
  resumeWorkers,
  stateFor,
  type WorkerState,
} from "./workers";

export async function runTask(
  state: WorkerState,
  root: string,
  params: TaskParams,
  signal?: AbortSignal,
): Promise<CustomToolResult> {
  state.active = true;
  try {
    // The agent loop validates Zod params, but custom-tool adapters forward them unchanged;
    // retain this guard for direct callers and semantic invariants not covered by the schema.
    validateTask(params);
    if (!("scope" in params)) {
      // OMP's strict tool schema transport materializes omitted optional fields as "" or false; keep omission as default behavior.
      params = {
        ...params,
        tasks: params.tasks.map(({ pushTo, role, model, startFrom, hold, pr, ...item }) => ({
          ...item,
          ...(pushTo ? { pushTo } : {}),
          ...(role ? { role } : {}),
          ...(model ? { model } : {}),
          ...(startFrom ? { startFrom } : {}),
          ...(hold ? { hold } : {}),
          ...(pr ? { pr } : {}),
        })),
      };
    }
    requireOwnership(state);
    await resumeWorkers(state);
    const active = params.tasks.find((item) => hasWorker(state, item.name));
    if (active) throw new Error(`Worker name already retained: ${active.name}`);
    if (params.tasks.some((item) => item.model)) {
      const catalog = await chatModels(state.deps, root, signal);
      params = {
        ...params,
        tasks: params.tasks.map((item) => {
          if (!item.model) return item;
          try {
            return { ...item, ...resolveModel(catalog, item.model) };
          } catch (error) {
            throw new Error(`Invalid OMP model for ${item.name}: ${errorMessage(error)}`);
          }
        }),
      };
    }
    const preflight = await preflightTask(state, root, params, signal);
    const launched = await Promise.all(
      params.tasks.map((item) =>
        launchWorker(state, root, preflight, params.context, item, signal),
      ),
    );
    return text(`Visible workers launched:\n${JSON.stringify(launched, null, 2)}`, launched);
  } catch (error) {
    return text(errorMessage(error), undefined, true);
  }
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
    for (const flag of ["hold", "pr"] as const) {
      if (item[flag] !== undefined && typeof item[flag] !== "boolean")
        throw new Error(`${flag} for ${item.name} must be a boolean`);
      if (item[flag] && item.kind !== "implementation")
        throw new Error(`Only implementation tasks can set ${flag}: ${item.name}`);
    }
    if (item.pr && !item.pushTo) throw new Error(`pr for ${item.name} requires pushTo`);
  }
}

async function preflightTask(
  state: WorkerState,
  root: string,
  params: TaskParams,
  signal?: AbortSignal,
): Promise<Preflight> {
  if ("scope" in params) {
    await requireHerdr(state, false, signal);
    const projects = await readProjects(root, signal);
    const canonicalRoot = await realpath(state.root);
    const forbiddenRoots = [canonicalRoot, ...Object.values(projects)];
    await mkdir(state.neutralRoot, { recursive: true });
    const base = await realpath(state.neutralRoot);
    for (const forbidden of forbiddenRoots) {
      const placement = relative(forbidden, base);
      if (!placement || (placement !== ".." && !placement.startsWith(`..${sep}`)))
        throw new Error(
          `Neutral working directory base is inside reserved project context: ${forbidden}`,
        );
    }
    return {
      scope: "independent",
      workspace: await researchSpace(state, signal),
      forbiddenRoots,
    };
  }
  const projects = await readProjects(root, signal);
  const projectPath = projects[params.project];
  if (!projectPath)
    throw new Error(
      `Unknown registered project: ${params.project}. Registered: ${Object.keys(projects).sort().join(", ") || "(none)"}`,
    );
  await requireHerdr(state, true, signal);
  let canonical: string;
  try {
    canonical = await realpath(projectPath);
  } catch {
    throw new Error(`Registered project path is missing: ${projectPath}`);
  }
  const top = await topLevel(state.deps, { cwd: canonical, signal });
  if ((await realpath(top)) !== canonical || canonical !== projectPath)
    throw new Error(`Registered path is not its exact Git root: ${projectPath}`);
  const initialHead = await head(state.deps, { cwd: canonical, signal });
  for (const item of params.tasks) {
    if (item.pushTo) await checkBranch(state.deps, item.pushTo, { cwd: canonical, signal });
    if (item.startFrom) await checkBranch(state.deps, item.startFrom, { cwd: canonical, signal });
  }
  const starts = Object.fromEntries(
    await Promise.all(
      params.tasks.flatMap((item) =>
        item.startFrom
          ? [
              branchHead(state.deps, item.startFrom, { cwd: canonical, signal }).then(
                (branchHead) => [item.name, branchHead] as const,
              ),
            ]
          : [],
      ),
    ),
  );
  const needsLocalDelivery = params.tasks.some(
    (item) => item.kind === "implementation" && !item.pushTo,
  );
  const needsLocalChanges =
    needsLocalDelivery || params.tasks.some((item) => item.kind === "scout");
  const localChanges = needsLocalChanges
    ? await status(state.deps, { cwd: canonical, signal })
    : "";
  let branch: string | undefined;
  if (needsLocalDelivery) {
    if (localChanges)
      throw new Error(`Registered project must be clean for local delivery: ${params.project}`);
    branch = await currentBranch(state.deps, { cwd: canonical, signal });
    if (!branch) throw new Error("Local delivery requires a named branch");
    const mismatched = params.tasks.find(
      (item) =>
        item.kind === "implementation" &&
        !item.pushTo &&
        item.startFrom &&
        item.startFrom !== branch,
    );
    if (mismatched)
      throw new Error(
        `Local delivery for ${mismatched.name} requires ${mismatched.startFrom} to be checked out`,
      );
  }
  // Workers start from local refs; flag a start that its remote has already moved past.
  const lags = new Map<string, Promise<string | undefined>>();
  const originWarnings: Record<string, string> = {};
  await Promise.all(
    params.tasks.map(async (item) => {
      const ref = item.startFrom ?? "HEAD";
      const startHead = starts[item.name] ?? initialHead;
      const key = `${ref}\0${startHead}`;
      if (!lags.has(key)) lags.set(key, originLag(state.deps, canonical, ref, startHead, signal));
      const warning = await lags.get(key);
      if (warning) originWarnings[item.name] = warning;
    }),
  );
  if (params.tasks.some((item) => item.pr)) {
    // Only a recognized host has a CLI to check; delivery still pushes the branch and reports an
    // unsupported host as pr_error, so an unknown origin must not refuse the launch.
    const forge = await originForge(state.deps, canonical, signal).catch(() => undefined);
    if (forge) await execCommand(state.deps, forge.cli, ["--version"], { signal });
  }
  return {
    scope: "project",
    project: params.project,
    projectPath: canonical,
    head: initialHead,
    branch,
    localChanges,
    starts,
    originWarnings,
  };
}

async function requireHerdr(
  state: WorkerState,
  projectScope: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (
    state.env.HERDR_ENV !== "1" ||
    !state.env.HERDR_SOCKET_PATH ||
    !state.env.HERDR_PANE_ID?.split(":", 1)[0]
  )
    throw new Error(
      "Herdr's OMP integration is required; run `herdr integration install omp` and restart OMP",
    );
  await Promise.all([
    ensureIntegration(state.deps, signal),
    ...(projectScope ? [gitVersion(state.deps, signal), treehouseVersion(state.deps, signal)] : []),
  ]);
}

/**
 * Builds the assignment each worker receives. Workers run unattended, so every prompt states the
 * observable finish line and what is safe to do without asking, instead of a step-by-step recipe.
 */
function workerPrompt(
  preflight: Preflight,
  context: string,
  item: TaskItem,
  directory: string,
  reportPath: string | undefined,
): string {
  const lead = context ? `${context}\n\n` : "";
  if (item.kind === "implementation")
    return `${lead}You are an unattended worker in an isolated worktree created for this assignment. You are done when the change works: implement it, run or exercise the changed behavior and the relevant local checks, fix failures your change causes, and commit every assignment change. Keep going until then rather than stopping for review; the worktree and its local checks are disposable, so run, fix, and rerun them without asking. Ask only when a missing decision would materially change the outcome, and mention optional extras as follow-ups instead of adding them. Work directly without delegating to subagents.\n\n${item.task}`;
  const finish = `You are done when the authoritative, non-empty standalone Markdown report is at ${reportPath} and your final message states the concise conclusion. Record whatever helps the reader (investigation, findings, evidence, recommendations, unresolved decisions) without fixed headings; unresolved decisions go in the report and do not block completion. Work directly without delegating to subagents.`;
  if (preflight.scope === "project") {
    const revision = preflight.starts[item.name] ?? preflight.head;
    const excluded = preflight.localChanges
      ? ` Disclose these excluded local changes in the report:\n${preflight.localChanges}`
      : " The registered checkout has no local changes to exclude.";
    return `${lead}You are a scout researching the exact committed revision ${revision} of this project. The registered checkout's local changes are excluded.${excluded}\nThis worktree is disposable: scratch edits, experiments, and commits are fine and are never delivered.\n\n${finish}\n\n${item.task}`;
  }
  return `${lead}You are a project-independent scout. No registered-project checkout or project revision applies, and project-specific context is intentionally excluded; global and user OMP instructions still apply. Scratch files in ${directory} are disposable and never delivered; do not create commits or implement changes for delivery. Public web search and public URL reads are enabled. Use authenticated external systems only when this assignment explicitly asks for them.\n\n${finish} Include source URLs and the research date in the report.\n\n${item.task}`;
}

async function launchWorker(
  state: WorkerState,
  root: string,
  preflight: Preflight,
  context: string,
  item: TaskItem,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const leaseHolder = `omp-orchestrator:${item.name}`;
  let lease: TreehouseLease | undefined;
  let directory: string | undefined;
  let workspaceId: string | undefined;
  let tabId: string | undefined;
  let paneId: string | undefined;
  let ompMayHaveStarted = false;
  let prompt: string | undefined;
  const originWarning =
    preflight.scope === "project" ? preflight.originWarnings[item.name] : undefined;
  const reportPath =
    item.kind === "scout"
      ? join(
          root,
          ".omp",
          "reports",
          preflight.scope === "independent" ? "_independent" : preflight.project,
          `${crypto.randomUUID()}-${item.name}.md`,
        )
      : undefined;
  try {
    if (preflight.scope === "project") {
      lease = await acquireLease(state.deps, preflight.projectPath, leaseHolder, signal);
      if (
        !isAbsolute(lease.path) ||
        !LEASE_ID.test(lease.leaseId) ||
        lease.leaseHolder !== leaseHolder
      )
        throw new Error("treehouse get returned an unrecognized lease");
      directory = lease.path;
      await resetHard(state.deps, directory, preflight.starts[item.name] ?? preflight.head, signal);
    } else {
      await mkdir(state.neutralRoot, { recursive: true });
      const base = await realpath(state.neutralRoot);
      for (const forbidden of preflight.forbiddenRoots) {
        const placement = relative(forbidden, base);
        if (!placement || (placement !== ".." && !placement.startsWith(`..${sep}`)))
          throw new Error(
            `Neutral working directory base is inside reserved project context: ${forbidden}`,
          );
      }
      const candidate = join(base, `${crypto.randomUUID()}-${item.name}`);
      await mkdir(candidate);
      directory = await realpath(candidate);
      for (const forbidden of preflight.forbiddenRoots) {
        const placement = relative(forbidden, directory);
        if (!placement || (placement !== ".." && !placement.startsWith(`..${sep}`)))
          throw new Error(
            `Neutral working directory is inside reserved project context: ${forbidden}`,
          );
      }
    }
    if (!directory) throw new Error("Worker directory was not allocated");
    if (reportPath) await mkdir(dirname(reportPath), { recursive: true });
    const label = workerLabel(item.kind, item.name);
    const space: HerdrSpace =
      preflight.scope === "project"
        ? await projectSpace(
            state,
            preflight.project,
            preflight.projectPath,
            directory,
            label,
            signal,
          )
        : {
            workspaceId: preflight.workspace,
            ...(await createTab(state.deps, preflight.workspace, directory, label, signal)),
          };
    workspaceId = space.workspaceId;
    tabId = space.tabId;
    paneId = space.paneId;
    await waitForShell(state.deps, paneId, signal);
    ompMayHaveStarted = true;
    await startOmpAgent(state.deps, item.name, paneId, directory, item, signal);
    prompt = workerPrompt(preflight, context, item, directory, reportPath);
    await promptAgent(state.deps, paneId, prompt, signal);
    const agent = await getAgent(state.deps, paneId, signal);
    if (agent.identity !== "omp")
      throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
    const record = workerRecord(
      agent.status === "blocked" ? "blocked" : "working",
      { workspaceId, tabId, paneId },
      directory,
    );
    adoptWorker(state, record, agent.status);
    return { ...publicRecord(record), ...(originWarning ? { origin_warning: originWarning } : {}) };
  } catch (error) {
    let failure = errorMessage(error);
    let retain = ompMayHaveStarted;
    if (!ompMayHaveStarted) {
      try {
        if (workspaceId && tabId)
          await closeWorkerSpace(
            state.deps,
            { scope: preflight.scope, workspace_id: workspaceId, tab_id: tabId },
            signal,
          );
        // Never return a lease while its Herdr shell might still be using the checkout.
        if (lease) await returnLease(state.deps, lease, signal);
        else if (directory) await rm(directory, { recursive: true });
      } catch (cleanupError) {
        retain = true;
        failure += `; cleanup failed: ${errorMessage(cleanupError)}`;
      }
    }
    if (retain && directory && workspaceId && tabId && paneId) {
      const record = workerRecord("failed", { workspaceId, tabId, paneId }, directory, failure);
      state.records.set(item.name, record);
      persist(state, record);
      return {
        ...publicRecord(record),
        ...(originWarning ? { origin_warning: originWarning } : {}),
      };
    }
    return {
      kind: item.kind,
      ...(preflight.scope === "independent"
        ? { scope: "independent" }
        : { project: preflight.project, delivery_base: preflight.head }),
      name: item.name,
      ...(item.role ? { role: item.role } : {}),
      ...(item.model ? { model: item.model } : {}),
      ...(item.thinking ? { thinking: item.thinking } : {}),
      status: "failed",
      ...(directory
        ? preflight.scope === "independent"
          ? { working_directory: directory }
          : { worktree: directory, lease_id: lease?.leaseId }
        : {}),
      ...(tabId ? { workspace_id: workspaceId, tab_id: tabId } : {}),
      ...(paneId ? { pane_id: paneId } : {}),
      ...(item.pushTo ? { push_to: item.pushTo } : {}),
      ...(reportPath
        ? {
            report_path: reportPath,
            ...(preflight.scope === "project" ? { local_changes: preflight.localChanges } : {}),
          }
        : {}),
      error: failure,
      ...(originWarning ? { origin_warning: originWarning } : {}),
    };
  }

  function workerRecord(
    status: WorkerRecord["status"],
    space: HerdrSpace,
    directory: string,
    error?: string,
  ): WorkerRecord {
    return {
      scope: preflight.scope,
      kind: item.kind,
      name: item.name,
      role: item.role,
      model: item.model,
      thinking: item.thinking,
      status,
      workspace_id: space.workspaceId,
      tab_id: space.tabId,
      pane_id: space.paneId,
      ...(preflight.scope === "project"
        ? {
            project: preflight.project,
            projectPath: preflight.projectPath,
            worktree: directory,
            lease_id: lease!.leaseId,
            lease_holder: lease!.leaseHolder,
            delivery_base: preflight.starts[item.name] ?? preflight.head,
            branch: preflight.branch,
            start_from: item.startFrom,
            push_to: item.pushTo,
            hold: item.hold,
            pr: item.pr,
            local_changes: item.kind === "scout" ? preflight.localChanges : undefined,
          }
        : { working_directory: directory }),
      report_path: reportPath,
      // Stored so a dead or wedged worker can be relaunched with its original assignment.
      prompt,
      error,
      generation: 0,
    };
  }
}

const taskTool: ToolFactory = (pi) => {
  const state = stateFor(pi);
  const z = pi.zod;

  return {
    name: "orchestrator_task",
    label: "Orchestrator task",
    loadMode: "essential",
    approval: "exec",
    description:
      "Launch visible OMP workers for one scope per call: implementation or scout workers in a registered project, or scouts with scope independent. Use for authorized project changes, and for investigation that should run as its own durable-report scout. Per task: role picks an OMP model role, or model picks an exact provider/id from the OMP model catalog with an optional :level thinking suffix (not both); startFrom a local branch; pushTo delivers to a remote branch instead of fast-forwarding locally; pr opens a draft pull request (GitHub) or merge request (GitLab), chosen from the origin remote, after pushTo; hold stops at status ready for review until workers land. A result carries origin_warning when its start is behind its remote. Returns after launch; completion wakes this session.",
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
                    role: z.string().optional(),
                    model: z.string().optional(),
                    pushTo: z.string().optional(),
                    startFrom: z.string().optional(),
                    hold: z.boolean().optional(),
                    pr: z.boolean().optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("scout"),
                    name: z.string(),
                    task: z.string(),
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
          context: z.string(),
          tasks: z
            .array(
              z
                .object({
                  kind: z.literal("scout"),
                  name: z.string(),
                  task: z.string(),
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
    execute: async (_id, params, signal) => runTask(state, pi.cwd, params as TaskParams, signal),
    onSession: (event) => handleSession(state, event.reason),
  };
};

export default taskTool;
