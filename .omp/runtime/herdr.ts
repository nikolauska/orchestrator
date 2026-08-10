import { errorMessage, execCommand, parseJson, stringAt, type RuntimeDeps } from "./shared";

export type HerdrAgent = { identity: string; status: string };
export type HerdrTab = { tabId: string; paneId: string };

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

export function closeTab(deps: RuntimeDeps, tab: string, signal?: AbortSignal): Promise<string> {
  return execCommand(deps, "herdr", ["tab", "close", tab], { signal });
}

export async function closeTabBestEffort(
  deps: RuntimeDeps,
  tab: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await closeTab(deps, tab, signal);
  } catch (error) {
    deps.logger.warn?.("Visible worker cleanup failed", {
      command: "herdr",
      error: errorMessage(error),
    });
  }
}
