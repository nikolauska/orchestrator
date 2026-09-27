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

export async function isAncestor(
  deps: RuntimeDeps,
  directory: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await deps.exec(
    "git",
    ["-C", directory, "merge-base", "--is-ancestor", ancestor, descendant],
    { signal },
  );
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git merge-base failed: ${errorMessage(result.stderr || result.stdout)}`);
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

/**
 * Describes how far `ref` (HEAD or a branch name) trails its upstream on the remote without
 * fetching, so the registered checkout's refs stay untouched. Returns undefined when the ref has
 * no upstream, such as a detached HEAD, or already contains the remote's commits.
 */
export async function originLag(
  deps: RuntimeDeps,
  directory: string,
  ref: string,
  head: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const fullRef =
      ref === "HEAD"
        ? await at(deps, directory, ["rev-parse", "--symbolic-full-name", "HEAD"], signal)
        : `refs/heads/${ref}`;
    if (!fullRef.startsWith("refs/heads/")) return undefined;
    const branch = fullRef.slice("refs/heads/".length);
    const [remote, remoteRef] = (
      await at(
        deps,
        directory,
        ["for-each-ref", "--format=%(upstream:remotename) %(upstream:remoteref)", fullRef],
        signal,
      )
    ).split(" ");
    if (!remote || !remoteRef) return undefined;
    const remoteHead = (
      await execCommand(deps, "git", ["-C", directory, "ls-remote", remote, remoteRef], {
        signal,
        timeout: 10_000,
      })
    ).split(/\s/, 1)[0];
    if (!remoteHead || remoteHead === head) return undefined;
    const upstream = `${remote}/${remoteRef.replace(/^refs\/heads\//, "")}`;
    const known =
      (
        await deps.exec("git", ["-C", directory, "cat-file", "-e", `${remoteHead}^{commit}`], {
          signal,
        })
      ).code === 0;
    if (!known)
      return `${branch} is behind ${upstream}: the remote has commits that were never fetched; workers start from local ${head}`;
    if (await isAncestor(deps, directory, remoteHead, head, signal)) return undefined;
    const behind = await at(
      deps,
      directory,
      ["rev-list", "--count", `${head}..${remoteHead}`],
      signal,
    );
    return `${branch} is ${behind} commit(s) behind ${upstream}; workers start from local ${head}`;
  } catch (error) {
    return `Could not compare ${ref} with its remote: ${errorMessage(error)}`;
  }
}

/** The hosting CLI that opens draft review requests, and how its output names the new request. */
export type Forge = {
  cli: "gh" | "glab";
  label: string;
  args(head: string, base: string | undefined): string[];
  url: RegExp;
};

const GITHUB: Forge = {
  cli: "gh",
  label: "pull request",
  args: (head, base) => [
    "pr",
    "create",
    "--draft",
    "--fill",
    "--head",
    head,
    ...(base ? ["--base", base] : []),
  ],
  url: /https?:\/\/\S+\/pull\/\d+/g,
};

const GITLAB: Forge = {
  cli: "glab",
  label: "merge request",
  // --yes skips the submit confirmation that would otherwise wait on an unattended run. Without a
  // target branch GitLab uses the project default, matching gh without --base.
  args: (head, base) => [
    "mr",
    "create",
    "--draft",
    "--fill",
    "--yes",
    "--source-branch",
    head,
    ...(base ? ["--target-branch", base] : []),
  ],
  url: /https?:\/\/\S+\/-\/merge_requests\/\d+/g,
};

/** Returns the lowercase host of an SSH, scp-like, or HTTP(S) Git remote URL. */
function remoteHost(url: string): string | undefined {
  // scp-like remotes (`git@host:group/repo.git`) have no scheme, so URL cannot parse them.
  const scpHost = /^(?:[^@/:]+@)?([^/:]+):(?!\/)/.exec(url)?.[1];
  if (scpHost) return scpHost.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks the forge from `origin`, because pushHead delivers the branch there and the review
 * request must be opened on the host that received it. Unknown hosts fail instead of guessing a
 * CLI that would target the wrong service.
 */
export async function originForge(
  deps: RuntimeDeps,
  directory: string,
  signal?: AbortSignal,
): Promise<Forge> {
  const url = await at(deps, directory, ["remote", "get-url", "origin"], signal);
  const host = remoteHost(url);
  if (host === "github.com") return GITHUB;
  // Self-hosted GitLab instances conventionally carry "gitlab" in their host name.
  if (host?.includes("gitlab")) return GITLAB;
  throw new Error(
    host
      ? `Unsupported origin host ${host}: draft requests can be opened only on GitHub (github.com) or GitLab`
      : `Unsupported origin remote ${url}: draft requests need a GitHub or GitLab host`,
  );
}

/**
 * Opens a draft pull request (GitHub) or merge request (GitLab) for an already pushed branch and
 * returns its web URL.
 */
export async function createDraftPullRequest(
  deps: RuntimeDeps,
  directory: string,
  head: string,
  base: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const forge = await originForge(deps, directory, signal);
  const output = await execCommand(deps, forge.cli, forge.args(head, base), {
    cwd: directory,
    signal,
  });
  // glab prints a summary around the URL on a terminal; returning any other line would hand back
  // a link that is not the request.
  const url = output.match(forge.url)?.at(-1);
  if (!url)
    throw new Error(
      `${forge.cli} reported no draft ${forge.label} URL: ${output.trim() || "(no output)"}`,
    );
  return url;
}
