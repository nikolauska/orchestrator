import { targetKey, type ExecutionTarget } from "./execution";
import {
  createWorkspace,
  listWorkspaces,
  openWorktree,
  renameWorkspace,
  type HerdrOptions,
  type HerdrSpace,
} from "./herdr";
import { errorMessage, type RuntimeDeps } from "./shared";

export const RESEARCH_SPACE = "research";
export type SpaceState = { deps: RuntimeDeps };
const queues = new WeakMap<SpaceState, Map<string, Promise<void>>>();

export function serializeSpaces<T>(
  state: SpaceState,
  target: ExecutionTarget,
  work: () => Promise<T>,
): Promise<T> {
  let targets = queues.get(state);
  if (!targets) {
    targets = new Map();
    queues.set(state, targets);
  }
  const key = targetKey(target);
  const result = (targets.get(key) ?? Promise.resolve()).then(work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  targets.set(key, settled);
  void settled.then(() => {
    if (targets.get(key) === settled) targets.delete(key);
  });
  return result;
}

export function researchSpace(
  state: SpaceState,
  target: ExecutionTarget,
  options: HerdrOptions = {},
): Promise<string> {
  return serializeSpaces(state, target, async () => {
    const existing = (await listWorkspaces(state.deps, target, options)).find(
      (workspace) => workspace.label === RESEARCH_SPACE,
    );
    if (existing) return existing.workspaceId;
    // Provisioning belongs to the host; never mkdir a remote path on the controller.
    return (
      await createWorkspace(state.deps, target, target.neutralRoot.path, RESEARCH_SPACE, options)
    ).workspaceId;
  });
}

export function projectSpace(
  state: SpaceState,
  target: ExecutionTarget,
  project: string,
  projectPath: string,
  checkout: string,
  label: string,
  options: HerdrOptions = {},
): Promise<HerdrSpace> {
  return serializeSpaces(state, target, async () => {
    const before = new Set(
      (await listWorkspaces(state.deps, target, options)).map((workspace) => workspace.workspaceId),
    );
    const space = await openWorktree(state.deps, target, projectPath, checkout, options);
    try {
      await renameWorkspace(state.deps, target, space.workspaceId, label, options);
      const parent = (await listWorkspaces(state.deps, target, options)).find(
        (workspace) => workspace.repoRoot === projectPath && !workspace.linked,
      );
      // Newly created parents use the registration name; existing user labels are preserved.
      if (parent && !before.has(parent.workspaceId))
        await renameWorkspace(state.deps, target, parent.workspaceId, project, options);
    } catch (error) {
      // Cosmetic failure must not lose the resource IDs needed to retain the opened space.
      state.deps.logger.warn?.("Project space rename failed", {
        project,
        target: targetKey(target),
        error: errorMessage(error),
      });
    }
    return space;
  });
}

export function workerLabel(kind: string, name: string): string {
  return `${kind === "scout" ? "scout" : "impl"}·${name}`;
}
