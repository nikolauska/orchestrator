import type { CustomToolFactory, CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { mkdir, realpath, rm } from "node:fs/promises";
import {
  IMPLEMENTATION_PROMPT_SUFFIX,
  LEASE_ID,
  NAME,
  errorMessage,
  text,
  type IndependentTaskParams,
  type Preflight,
  type ProjectPreflight,
  type ProjectTaskParams,
  type TaskItem,
  type TaskParams,
  type WorkerRecord,
} from "../runtime/shared";
import { readProjects, validateName } from "./projects";
import {
  branchHead,
  checkBranch,
  currentBranch,
  head,
  resetHard,
  status,
  topLevel,
  version as gitVersion,
} from "../runtime/git";
import {
  closeWorkerSpace,
  createTab,
  createWorkspace,
  ensureIntegration,
  getAgent,
  listWorkspaces,
  openWorktree,
  promptAgent,
  renameWorkspace,
  startOmpAgent,
  waitForShell,
  type HerdrSpace,
} from "../runtime/herdr";
import {
  acquireLease,
  returnLease,
  type TreehouseLease,
  version as treehouseVersion,
} from "../runtime/treehouse";
import {
  adoptWorker,
  handleSession,
  hasWorker,
  persist,
  publicRecord,
  resumeWorkers,
  stateFor,
  type WorkerState,
} from "./workers";

const RESEARCH_SPACE = "research";

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
      // OMP's strict tool schema transport materializes omitted optional strings as ""; keep omission as default behavior.
      params = {
        ...params,
        tasks: params.tasks.map(({ pushTo, role, startFrom, ...item }) => ({
          ...item,
          ...(pushTo ? { pushTo } : {}),
          ...(role ? { role } : {}),
          ...(startFrom ? { startFrom } : {}),
        })),
      };
    }
    await resumeWorkers(state);
    const active = params.tasks.find((item) => hasWorker(state, item.name));
    if (active) throw new Error(`Worker name already retained: ${active.name}`);
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
  return {
    scope: "project",
    project: params.project,
    projectPath: canonical,
    head: initialHead,
    branch,
    localChanges,
    starts,
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

/** Runs Herdr space lookups and creation one at a time so parallel launches never create duplicate spaces. */
function serializeSpaces<T>(state: WorkerState, work: () => Promise<T>): Promise<T> {
  const result = state.spaceQueue.then(work);
  state.spaceQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function researchSpace(state: WorkerState, signal?: AbortSignal): Promise<string> {
  return serializeSpaces(state, async () => {
    const existing = (await listWorkspaces(state.deps, signal)).find(
      (workspace) => workspace.label === RESEARCH_SPACE,
    );
    if (existing) return existing.workspaceId;
    await mkdir(state.neutralRoot, { recursive: true });
    return (await createWorkspace(state.deps, state.neutralRoot, RESEARCH_SPACE, signal))
      .workspaceId;
  });
}

function projectSpace(
  state: WorkerState,
  preflight: ProjectPreflight,
  checkout: string,
  label: string,
  signal?: AbortSignal,
): Promise<HerdrSpace> {
  return serializeSpaces(state, async () => {
    const before = new Set(
      (await listWorkspaces(state.deps, signal)).map((workspace) => workspace.workspaceId),
    );
    const space = await openWorktree(state.deps, preflight.projectPath, checkout, signal);
    try {
      await renameWorkspace(state.deps, space.workspaceId, label, signal);
      const parent = (await listWorkspaces(state.deps, signal)).find(
        (workspace) => workspace.repoRoot === preflight.projectPath && !workspace.linked,
      );
      // Herdr names a parent it creates after the checkout folder; a space the user already had keeps its label.
      if (parent && !before.has(parent.workspaceId))
        await renameWorkspace(state.deps, parent.workspaceId, preflight.project, signal);
    } catch (error) {
      // The name is cosmetic; the worker space is already open and must still be tracked.
      state.deps.logger.warn?.("Project space rename failed", {
        project: preflight.project,
        error: errorMessage(error),
      });
    }
    return space;
  });
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
    // The kind prefix tells implementation work from research at a glance in Herdr's sidebar.
    const label = `${item.kind === "scout" ? "scout" : "impl"}·${item.name}`;
    const space: HerdrSpace =
      preflight.scope === "project"
        ? await projectSpace(state, preflight, directory, label, signal)
        : {
            workspaceId: preflight.workspace,
            ...(await createTab(state.deps, preflight.workspace, directory, label, signal)),
          };
    workspaceId = space.workspaceId;
    tabId = space.tabId;
    paneId = space.paneId;
    await waitForShell(state.deps, paneId, signal);
    ompMayHaveStarted = true;
    await startOmpAgent(state.deps, item.name, paneId, directory, item.role, signal);
    const prompt =
      item.kind === "implementation"
        ? `${context}\n\n${IMPLEMENTATION_PROMPT_SUFFIX}\nUse the ponytail skill for this assignment.\n\n${item.task}`
        : preflight.scope === "project"
          ? `${context}\n\nResearch only the exact committed revision ${preflight.starts[item.name] ?? preflight.head}; the registered checkout's local changes are excluded and disclosed in the report.${preflight.localChanges ? ` Disclose these excluded local changes in the report:\n${preflight.localChanges}` : " The registered checkout has no local changes to exclude."}\nYou may make scratch edits or commits only in this disposable worktree. They will never be delivered. Write the authoritative, non-empty standalone Markdown report to ${reportPath}. Cover the investigation, findings, evidence, recommendations, and unresolved decisions as useful without fixed headings. Return a concise terminal conclusion. Unresolved decisions do not block completion. Complete this assignment directly; do not delegate to subagents.\n\n${item.task}`
          : `${context}\n\nThis is a project-independent scout. No registered-project checkout or project revision applies, and project-specific context is intentionally excluded. Global and user OMP instructions still apply. Scratch files in ${directory} are disposable and are never delivered; do not create commits. Public web search and reads of public URLs are enabled by default. Access authenticated external systems only when this assignment explicitly instructs it. Write the authoritative, non-empty standalone Markdown report to ${reportPath}. Include source URLs and the research date. Cover the investigation, findings, evidence, recommendations, and unresolved decisions as useful without fixed headings. Return a concise terminal conclusion. Unresolved decisions do not block completion. Complete this assignment directly; do not delegate to subagents. Do not implement changes for delivery.\n\n${item.task}`;
    await promptAgent(state.deps, paneId, prompt, signal);
    const agent = await getAgent(state.deps, paneId, signal);
    if (agent.identity !== "omp")
      throw new Error(`Unexpected Herdr agent identity: ${agent.identity || "missing"}`);
    const record: WorkerRecord = {
      scope: preflight.scope,
      kind: item.kind,
      name: item.name,
      role: item.role,
      status: agent.status === "blocked" ? "blocked" : "working",
      workspace_id: workspaceId,
      tab_id: tabId,
      pane_id: paneId,
      ...(preflight.scope === "project"
        ? {
            project: preflight.project,
            projectPath: preflight.projectPath,
            worktree: directory,
            lease_id: lease!.leaseId,
            lease_holder: lease!.leaseHolder,
            delivery_base: preflight.starts[item.name] ?? preflight.head,
            branch: preflight.branch,
            push_to: item.pushTo,
            local_changes: item.kind === "scout" ? preflight.localChanges : undefined,
          }
        : { working_directory: directory }),
      report_path: reportPath,
      generation: 0,
    };
    adoptWorker(state, record, agent.status);
    return publicRecord(record);
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
      const record: WorkerRecord = {
        scope: preflight.scope,
        kind: item.kind,
        name: item.name,
        role: item.role,
        status: "failed",
        workspace_id: workspaceId,
        tab_id: tabId,
        pane_id: paneId,
        ...(preflight.scope === "project"
          ? {
              project: preflight.project,
              projectPath: preflight.projectPath,
              worktree: directory,
              lease_id: lease!.leaseId,
              lease_holder: lease!.leaseHolder,
              delivery_base: preflight.starts[item.name] ?? preflight.head,
              branch: preflight.branch,
              push_to: item.pushTo,
              local_changes: item.kind === "scout" ? preflight.localChanges : undefined,
            }
          : { working_directory: directory }),
        report_path: reportPath,
        error: failure,
        generation: 0,
      };
      state.records.set(item.name, record);
      persist(state, record);
      return publicRecord(record);
    }
    return {
      kind: item.kind,
      ...(preflight.scope === "independent"
        ? { scope: "independent" }
        : { project: preflight.project, delivery_base: preflight.head }),
      name: item.name,
      ...(item.role ? { role: item.role } : {}),
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
    };
  }
}

const taskTool: CustomToolFactory = (pi) => {
  const state = stateFor(pi);
  const z = pi.zod;

  return {
    name: "orchestrator_task",
    label: "Orchestrator task",
    loadMode: "essential",
    approval: "exec",
    description:
      "Launch project-scoped implementation or scout OMP workers, or project-independent scouts, in visible Herdr spaces. Each project worker gets its own Treehouse worktree space nested under the project's Herdr space; independent scouts run as tabs in a shared research space, using unique neutral working directories and public web research by default. One orchestrator_task call has one scope. Each assignment may select an OMP model role: smol for bounded research or mechanical work, slow for deep diagnosis or review, plan for architecture/schema/migration planning, designer for UI/UX, or vision for image inspection; omit role for normal work. Scouts produce durable reports and cannot deliver changes. Returns after launch; completion wakes this root session. Use projects to list targets and workers, not hub, to list, message, or close agents.",
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
                    pushTo: z.string().optional(),
                    startFrom: z.string().optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("scout"),
                    name: z.string(),
                    task: z.string(),
                    role: z.string().optional(),
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
                })
                .strict(),
            )
            .min(1)
            .max(32),
        })
        .strict(),
    ]),
    execute: async (_id, params, _onUpdate, _ctx, signal) =>
      runTask(state, pi.cwd, params as TaskParams, signal),
    onSession: (event) => handleSession(state, event.reason),
  };
};

export default taskTool;
