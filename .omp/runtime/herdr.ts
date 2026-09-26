import {
  errorMessage,
  execCommand,
  parseJson,
  stringAt,
  valueAt,
  type RuntimeDeps,
  type WorkerRecord,
} from "./shared";

export type HerdrAgent = { identity: string; status: string };
export type HerdrTab = { tabId: string; paneId: string };
export type HerdrSpace = HerdrTab & { workspaceId: string };
export type HerdrWorkspace = {
  workspaceId: string;
  label: string;
  repoRoot?: string;
  checkoutPath?: string;
  linked: boolean;
};

export async function ensureIntegration(deps: RuntimeDeps, signal?: AbortSignal): Promise<void> {
  await Promise.all([
    execCommand(deps, "herdr", ["--version"], { signal }),
    execCommand(deps, "omp", ["--version"], { signal }),
  ]);
}

export async function getAgent(
  deps: RuntimeDeps,
  pane: string,
  signal?: AbortSignal,
): Promise<HerdrAgent> {
  const value = parseJson(
    await execCommand(deps, "herdr", ["agent", "get", pane], { signal }),
    "herdr agent get",
  );
  return {
    identity: stringAt(value, ["result", "agent", "agent"]) ?? "",
    status: stringAt(value, ["result", "agent", "agent_status"]) ?? "",
  };
}

export async function promptAgent(
  deps: RuntimeDeps,
  pane: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await execCommand(
      deps,
      "herdr",
      [
        "agent",
        "prompt",
        pane,
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
      { signal },
    );
  } catch (error) {
    if (!errorMessage(error).includes("agent_prompt_stalled")) throw error;
    // Herdr has already typed the text when startup stalls; retry only Enter to avoid duplicating it.
    await execCommand(deps, "herdr", ["agent", "send-keys", pane, "enter"], { signal });
    await execCommand(
      deps,
      "herdr",
      [
        "agent",
        "wait",
        pane,
        "--until",
        "working",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        "5000",
      ],
      { signal },
    );
  }
}

export function waitForAgent(
  deps: RuntimeDeps,
  pane: string,
  signal?: AbortSignal,
): Promise<string> {
  return execCommand(
    deps,
    "herdr",
    ["agent", "wait", pane, "--until", "idle", "--until", "done", "--until", "blocked"],
    { signal },
  );
}

export function readAgent(deps: RuntimeDeps, pane: string, signal?: AbortSignal): Promise<string> {
  return execCommand(
    deps,
    "herdr",
    ["agent", "read", pane, "--source", "recent-unwrapped", "--lines", "200", "--format", "text"],
    { signal },
  );
}

export async function listWorkspaces(
  deps: RuntimeDeps,
  signal?: AbortSignal,
): Promise<HerdrWorkspace[]> {
  const value = parseJson(
    await execCommand(deps, "herdr", ["workspace", "list"], { signal }),
    "herdr workspace list",
  );
  const workspaces = valueAt(value, ["result", "workspaces"]);
  if (!Array.isArray(workspaces))
    throw new Error("herdr workspace list returned unrecognized workspaces");
  return workspaces.flatMap((item: unknown) => {
    const workspaceId = stringAt(item, ["workspace_id"]);
    if (!workspaceId) return [];
    return [
      {
        workspaceId,
        label: stringAt(item, ["label"]) ?? "",
        repoRoot: stringAt(item, ["worktree", "repo_root"]),
        checkoutPath: stringAt(item, ["worktree", "checkout_path"]),
        linked: valueAt(item, ["worktree", "is_linked_worktree"]) === true,
      },
    ];
  });
}

function spaceFrom(value: unknown, command: string): HerdrSpace {
  const workspaceId = stringAt(value, ["result", "workspace", "workspace_id"]);
  const tabId = stringAt(value, ["result", "tab", "tab_id"]);
  const paneId = stringAt(value, ["result", "root_pane", "pane_id"]);
  if (!workspaceId || !tabId || !paneId)
    throw new Error(`${command} returned unrecognized identifiers`);
  return { workspaceId, tabId, paneId };
}

export async function createWorkspace(
  deps: RuntimeDeps,
  directory: string,
  label: string,
  signal?: AbortSignal,
): Promise<HerdrSpace> {
  return spaceFrom(
    parseJson(
      await execCommand(
        deps,
        "herdr",
        ["workspace", "create", "--cwd", directory, "--label", label, "--no-focus"],
        { signal },
      ),
      "herdr workspace create",
    ),
    "herdr workspace create",
  );
}

export async function openWorktree(
  deps: RuntimeDeps,
  repository: string,
  checkout: string,
  signal?: AbortSignal,
): Promise<HerdrSpace> {
  // Herdr groups the checkout under the repository's space. Omitting --label avoids
  // relabeling somebody else's workspace when Herdr reports already_open.
  const value = parseJson(
    await execCommand(
      deps,
      "herdr",
      ["worktree", "open", "--cwd", repository, "--path", checkout, "--no-focus"],
      { signal },
    ),
    "herdr worktree open",
  );
  // An already-open checkout space belongs to someone else; adopting it would hijack its panes.
  if (valueAt(value, ["result", "already_open"]) === true)
    throw new Error(`Worktree is already open in Herdr: ${checkout}`);
  return spaceFrom(value, "herdr worktree open");
}

export function renameWorkspace(
  deps: RuntimeDeps,
  workspace: string,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  return execCommand(deps, "herdr", ["workspace", "rename", workspace, label], { signal });
}

export async function createTab(
  deps: RuntimeDeps,
  workspace: string,
  directory: string,
  label: string,
  signal?: AbortSignal,
): Promise<HerdrTab> {
  const value = parseJson(
    await execCommand(
      deps,
      "herdr",
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
      { signal },
    ),
    "herdr tab create",
  );
  const tabId = stringAt(value, ["result", "tab", "tab_id"]);
  const paneId = stringAt(value, ["result", "root_pane", "pane_id"]);
  if (!tabId || !paneId) throw new Error("herdr tab create returned unrecognized identifiers");
  return { tabId, paneId };
}

export function waitForShell(
  deps: RuntimeDeps,
  pane: string,
  signal?: AbortSignal,
): Promise<string> {
  // A tab can exist before its shell accepts an agent startup command.
  return execCommand(
    deps,
    "herdr",
    [
      "pane",
      "wait-output",
      pane,
      "--regex",
      "[#$>]\\s*$",
      "--source",
      "visible",
      "--lines",
      "10",
      "--timeout",
      "5000",
    ],
    { signal },
  );
}

export function startOmpAgent(
  deps: RuntimeDeps,
  name: string,
  pane: string,
  directory: string,
  role: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  return execCommand(
    deps,
    "herdr",
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
      ...(role ? ["--model", `@${role}`] : []),
    ],
    { signal },
  );
}

type WorkerSpace = Pick<WorkerRecord, "scope" | "workspace_id" | "tab_id">;

/** Project workers own a whole worktree space; independent scouts own one tab in the research space. */
export async function closeWorkerSpace(
  deps: RuntimeDeps,
  worker: WorkerSpace,
  signal?: AbortSignal,
): Promise<void> {
  const args =
    worker.scope === "project"
      ? ["workspace", "close", worker.workspace_id]
      : ["tab", "close", worker.tab_id];
  try {
    await execCommand(deps, "herdr", args, { signal });
  } catch (error) {
    // A space the user already closed is already in the state cleanup wants.
    if (!/"code":"(workspace|tab)_not_found"/.test(errorMessage(error))) throw error;
  }
}

export async function closeWorkerSpaceBestEffort(
  deps: RuntimeDeps,
  worker: WorkerSpace,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await closeWorkerSpace(deps, worker, signal);
  } catch (error) {
    deps.logger.warn?.("Visible worker cleanup failed", {
      command: "herdr",
      error: errorMessage(error),
    });
  }
}
