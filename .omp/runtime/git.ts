import { errorMessage, execCommand, type RuntimeDeps } from "./shared";

type CommandOptions = { cwd?: string; signal?: AbortSignal };

function at(
  deps: RuntimeDeps,
  directory: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return execCommand(deps, "git", ["-C", directory, ...args], { signal });
}

export function version(deps: RuntimeDeps, signal?: AbortSignal): Promise<string> {
  return execCommand(deps, "git", ["--version"], { signal });
}

export function topLevel(deps: RuntimeDeps, options: CommandOptions): Promise<string> {
  return execCommand(deps, "git", ["rev-parse", "--show-toplevel"], options);
}

export function head(deps: RuntimeDeps, options: CommandOptions): Promise<string> {
  return execCommand(deps, "git", ["rev-parse", "HEAD"], options);
}

export function headAt(
  deps: RuntimeDeps,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  return at(deps, directory, ["rev-parse", "HEAD"], signal);
}

export function checkBranch(
  deps: RuntimeDeps,
  branch: string,
  options: CommandOptions,
): Promise<string> {
  return execCommand(deps, "git", ["check-ref-format", "--branch", branch], options);
}

export function branchHead(
  deps: RuntimeDeps,
  branch: string,
  options: CommandOptions,
): Promise<string> {
  return execCommand(deps, "git", ["rev-parse", "--verify", `refs/heads/${branch}`], options);
}

export function status(deps: RuntimeDeps, options: CommandOptions): Promise<string> {
  return execCommand(deps, "git", ["status", "--porcelain=v1", "--untracked-files=all"], options);
}

export function statusAt(
  deps: RuntimeDeps,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  return at(deps, directory, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
}

export function currentBranch(deps: RuntimeDeps, options: CommandOptions): Promise<string> {
  return execCommand(deps, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
}

export function currentBranchAt(
  deps: RuntimeDeps,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  return at(deps, directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
}

export function resetHard(
  deps: RuntimeDeps,
  directory: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string> {
  return at(deps, directory, ["reset", "--hard", commit], signal);
}

export function pushHead(
  deps: RuntimeDeps,
  directory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  return at(deps, directory, ["push", "origin", `HEAD:refs/heads/${branch}`], signal);
}

export function fastForward(
  deps: RuntimeDeps,
  directory: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string> {
  return at(deps, directory, ["merge", "--ff-only", commit], signal);
}

export function rebaseOnto(
  deps: RuntimeDeps,
  directory: string,
  current: string,
  deliveryBase: string,
  workerHead: string,
  signal?: AbortSignal,
): Promise<string> {
  return at(deps, directory, ["rebase", "--onto", current, deliveryBase, workerHead], signal);
}

export function abortRebase(
  deps: RuntimeDeps,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  return at(deps, directory, ["rebase", "--abort"], signal);
}

export async function abortRebaseBestEffort(
  deps: RuntimeDeps,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await abortRebase(deps, directory, signal);
  } catch (error) {
    deps.logger.warn?.("Visible worker cleanup failed", {
      command: "git",
      error: errorMessage(error),
    });
  }
}
