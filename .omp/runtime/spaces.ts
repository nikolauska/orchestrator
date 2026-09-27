import { mkdir } from "node:fs/promises";
import {
  createWorkspace,
  listWorkspaces,
  openWorktree,
  renameWorkspace,
  type HerdrSpace,
} from "./herdr";
import { errorMessage, type RuntimeDeps } from "./shared";

export const RESEARCH_SPACE = "research";

type SpaceState = { deps: RuntimeDeps; neutralRoot: string; spaceQueue: Promise<void> };

/** Runs Herdr space lookups and creation one at a time so parallel launches never create duplicate spaces. */
function serializeSpaces<T>(state: SpaceState, work: () => Promise<T>): Promise<T> {
  const result = state.spaceQueue.then(work);
  state.spaceQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function researchSpace(state: SpaceState, signal?: AbortSignal): Promise<string> {
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

export function projectSpace(
  state: SpaceState,
  project: string,
  projectPath: string,
  checkout: string,
  label: string,
  signal?: AbortSignal,
): Promise<HerdrSpace> {
  return serializeSpaces(state, async () => {
    const before = new Set(
      (await listWorkspaces(state.deps, signal)).map((workspace) => workspace.workspaceId),
    );
    const space = await openWorktree(state.deps, projectPath, checkout, signal);
    try {
      await renameWorkspace(state.deps, space.workspaceId, label, signal);
      const parent = (await listWorkspaces(state.deps, signal)).find(
        (workspace) => workspace.repoRoot === projectPath && !workspace.linked,
      );
      // Herdr names a parent it creates after the checkout folder; a space the user already had keeps its label.
      if (parent && !before.has(parent.workspaceId))
        await renameWorkspace(state.deps, parent.workspaceId, project, signal);
    } catch (error) {
      // The name is cosmetic; the worker space is already open and must still be tracked.
      state.deps.logger.warn?.("Project space rename failed", {
        project,
        error: errorMessage(error),
      });
    }
    return space;
  });
}

/** The kind prefix tells implementation work from research at a glance in Herdr's sidebar. */
export function workerLabel(kind: string, name: string): string {
  return `${kind === "scout" ? "scout" : "impl"}·${name}`;
}
