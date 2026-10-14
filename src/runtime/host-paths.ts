import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { HostPath } from "./execution";
import type { HostError } from "./helper-protocol";

export class HostFailure extends Error {
  readonly detail: HostError;
  constructor(
    code: HostError["code"],
    message: string,
    options: Partial<Omit<HostError, "code" | "message">> = {},
  ) {
    super(message);
    this.name = "HostFailure";
    this.detail = {
      code,
      message: message.slice(0, 4096),
      channel: "helper",
      effect: "none",
      retry: "user_action",
      ...options,
    };
  }
}

export type PathRules = {
  os?: "linux" | "darwin" | "win32";
  home?: string;
  realpath?: (path: string) => Promise<string>;
  identity?: (path: string) => Promise<string>;
};

function rules(options: PathRules) {
  return options.os === "win32" || (!options.os && process.platform === "win32") ? win32 : posix;
}

export function nativeAbsolutePath(value: string, options: PathRules = {}): string {
  const paths = rules(options);
  if (!value || value.includes("\0"))
    throw new HostFailure("PATH_INVALID", "Path must be nonempty and contain no NUL.");
  if (value === "~" || /^~[\\/]/.test(value))
    value = paths.join(options.home ?? homedir(), value.slice(2));
  if (paths === win32) {
    if (
      /^[\\/]{2}[?.][\\/]/.test(value) ||
      !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value)
    )
      throw new HostFailure(
        "PATH_INVALID",
        "Use a fully qualified drive or UNC path; drive-relative, device and drive-ambiguous paths are forbidden.",
      );
    // Win32 aliases such as trailing dots and alternate streams bypass ordinary containment.
    if (
      value
        .slice(/^[a-z]:/i.test(value) ? 2 : 0)
        .split(/[\\/]/)
        .some(
          (part) =>
            part !== "." &&
            part !== ".." &&
            (/[<>:"|?*]|[. ]$/.test(part) ||
              /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)),
        )
    )
      throw new HostFailure(
        "PATH_INVALID",
        "Device aliases, alternate streams and trailing dots/spaces are not supported paths.",
      );
  } else if (!paths.isAbsolute(value))
    throw new HostFailure("PATH_INVALID", "Use an absolute path or ~/ on the execution host.");
  return paths.normalize(value);
}

export async function pathIdentity(path: string, options: PathRules = {}): Promise<string> {
  if (options.identity) return options.identity(path);
  const info = await stat(path, { bigint: true });
  if (info.ino === 0n)
    throw new HostFailure(
      "CAPABILITY_MISSING",
      "Filesystem does not expose stable file identities; use a supported local filesystem.",
    );
  // File identity preserves case-sensitive directories while collapsing aliases and junctions.
  return `file:${info.dev}:${info.ino}`;
}

export async function canonicalPath(
  value: string,
  options: PathRules & { allowMissing?: boolean } = {},
): Promise<HostPath> {
  const paths = rules(options);
  let current = nativeAbsolutePath(value, options);
  const missing: string[] = [];
  for (;;) {
    try {
      let canonical = await (options.realpath ?? realpath)(current);
      if (paths === win32)
        canonical = canonical
          .replace(/^\\\\\?\\UNC\\/i, "\\\\")
          .replace(/^\\\\\?\\(?=[a-z]:\\)/i, "");
      const key = await pathIdentity(canonical, options);
      return {
        path: paths.join(canonical, ...missing),
        pathKey: missing.length ? `pending:${JSON.stringify([key, ...missing])}` : key,
      };
    } catch (error) {
      if (
        !options.allowMissing ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      const parent = paths.dirname(current);
      if (parent === current) throw error;
      missing.unshift(paths.basename(current));
      current = parent;
    }
  }
}

export async function assertContained(
  root: string | HostPath,
  candidate: string | HostPath,
  options: PathRules & { allowEqual?: boolean; allowMissing?: boolean } = {},
): Promise<void> {
  const rootPath = await canonicalPath(typeof root === "string" ? root : root.path, options);
  const child = await canonicalPath(
    typeof candidate === "string" ? candidate : candidate.path,
    options,
  );
  if (typeof root !== "string" && rootPath.pathKey !== root.pathKey)
    throw new HostFailure(
      "PATH_FORBIDDEN",
      "Root identity changed; restore the original host directory.",
    );
  if (typeof candidate !== "string" && child.pathKey !== candidate.pathKey)
    throw new HostFailure(
      "PATH_FORBIDDEN",
      "Directory identity changed; retained work must not be redirected.",
    );
  const paths = rules(options);
  let current = child.path;
  for (;;) {
    const ancestor = await canonicalPath(current, { ...options, allowMissing: true });
    if (
      ancestor.pathKey === rootPath.pathKey &&
      (options.allowEqual !== false || child.pathKey !== rootPath.pathKey)
    )
      return;
    const parent = paths.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new HostFailure(
    "PATH_FORBIDDEN",
    "Path escapes its approved host root (including symlink/junction targets).",
  );
}

export async function pathsOverlap(a: string | HostPath, b: string | HostPath): Promise<boolean> {
  for (const [root, child] of [
    [a, b],
    [b, a],
  ] as const) {
    try {
      await assertContained(root, child, { allowMissing: true });
      return true;
    } catch (error) {
      if (!(error instanceof HostFailure) || error.detail.code !== "PATH_FORBIDDEN") throw error;
    }
  }
  return false;
}
