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
  closeTabBestEffort,
  createTab,
  ensureIntegration,
  getAgent,
  promptAgent,
  startOmpAgent,
  waitForShell,
} from "../runtime/herdr";
import {
  acquireLease,
  returnLeaseBestEffort,
  type TreehouseLease,
  version as treehouseVersion,
} from "../runtime/treehouse";
import {
  adoptWorker,
  disposeWorkers,
  hasWorker,
  publicRecord,
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
    const workspace = await workspaceFor(state, false, signal);
    const projects = await readProjects(root, signal);
    const canonicalRoot = await realpath(state.root);
    return {
      scope: "independent",
      workspace,
      forbiddenRoots: [canonicalRoot, ...Object.values(projects)],
    };
  }
  const projects = await readProjects(root, signal);
  const projectPath = projects[params.project];
  if (!projectPath)
    throw new Error(
      `Unknown registered project: ${params.project}. Registered: ${Object.keys(projects).sort().join(", ") || "(none)"}`,
    );
  const workspace = await workspaceFor(state, true, signal);
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
    workspace,
    head: initialHead,
    branch,
    localChanges,
    starts,
  };
}

async function workspaceFor(
  state: WorkerState,
  projectScope: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const pane = state.env.HERDR_PANE_ID;
  const workspace = pane?.split(":", 1)[0];
  if (state.env.HERDR_ENV !== "1" || !state.env.HERDR_SOCKET_PATH || !workspace)
    throw new Error(
      "Herdr's OMP integration is required; run `herdr integration install omp` and restart OMP",
    );
  await Promise.all([
    ensureIntegration(state.deps, signal),
    ...(projectScope ? [gitVersion(state.deps, signal), treehouseVersion(state.deps, signal)] : []),
  ]);
  return workspace;
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
    const tab = await createTab(state.deps, preflight.workspace, directory, item.name, signal);
    tabId = tab.tabId;
    paneId = tab.paneId;
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
      workspace_id: preflight.workspace,
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
    const message = errorMessage(error);
    if (!ompMayHaveStarted) {
      if (tabId) await closeTabBestEffort(state.deps, tabId, signal);
      if (lease) await returnLeaseBestEffort(state.deps, lease, signal);
      else if (directory) {
        try {
          await rm(directory, { recursive: true });
        } catch (cleanupError) {
          state.deps.logger.warn?.("Visible worker cleanup failed", {
            directory,
            error: errorMessage(cleanupError),
          });
        }
      }
    } else if (directory && tabId && paneId) {
      const record: WorkerRecord = {
        scope: preflight.scope,
        kind: item.kind,
        name: item.name,
        role: item.role,
        status: "failed",
        workspace_id: preflight.workspace,
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
        error: message,
        generation: 0,
      };
      state.records.set(item.name, record);
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
      ...(tabId ? { workspace_id: preflight.workspace, tab_id: tabId } : {}),
      ...(paneId ? { pane_id: paneId } : {}),
      ...(item.pushTo ? { push_to: item.pushTo } : {}),
      ...(reportPath
        ? {
            report_path: reportPath,
            ...(preflight.scope === "project" ? { local_changes: preflight.localChanges } : {}),
          }
        : {}),
      error: message,
    };
  }
}

const taskTool: CustomToolFactory = (pi) => {
  const state = stateFor(pi);
  const z = pi.zod;

  return {
    name: "orchestrator_task",
    label: "Visible Workers",
    loadMode: "essential",
    approval: "exec",
    description:
      "Launch project-scoped implementation or scout OMP workers, or project-independent scouts, in visible Herdr tabs. Project workers use isolated Treehouse worktrees; independent scouts use unique neutral working directories and public web research by default. One orchestrator_task call has one scope. Each assignment may select an OMP model role: smol for bounded research or mechanical work, slow for deep diagnosis or review, plan for architecture/schema/migration planning, designer for UI/UX, or vision for image inspection; omit role for normal work. Scouts produce durable reports and cannot deliver changes. Returns after launch; completion wakes this root session. Use projects to list targets and workers, not hub, to list or message agents.",
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
    onSession: (event) => {
      if (event.reason === "switch" || event.reason === "shutdown") disposeWorkers(state);
    },
  };
};

export default taskTool;
