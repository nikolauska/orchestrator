import { errorMessage, execCommand, parseJson, stringAt, type RuntimeDeps } from "./shared";

export type TreehouseLease = { path: string; leaseId: string; leaseHolder: string };

export function version(deps: RuntimeDeps, signal?: AbortSignal): Promise<string> {
  return execCommand(deps, "treehouse", ["--version"], { signal });
}

export async function acquireLease(
  deps: RuntimeDeps,
  projectPath: string,
  leaseHolder: string,
  signal?: AbortSignal,
): Promise<TreehouseLease> {
  const value = parseJson(
    await execCommand(
      deps,
      "treehouse",
      ["get", "--lease", "--lease-holder", leaseHolder, "--json"],
      { cwd: projectPath, signal },
    ),
    "treehouse get",
  );
  const path = stringAt(value, ["path"]);
  const leaseId = stringAt(value, ["lease_id"]);
  const echoedHolder = stringAt(value, ["lease_holder"]);
  if (!path || !leaseId || !echoedHolder)
    throw new Error("treehouse get returned unrecognized lease");
  return { path, leaseId, leaseHolder: echoedHolder };
}

export function returnLease(
  deps: RuntimeDeps,
  lease: TreehouseLease,
  signal?: AbortSignal,
): Promise<string> {
  return execCommand(
    deps,
    "treehouse",
    [
      "return",
      "--force",
      "--if-lease-id",
      lease.leaseId,
      "--if-lease-holder",
      lease.leaseHolder,
      lease.path,
    ],
    { signal },
  );
}

export async function returnLeaseBestEffort(
  deps: RuntimeDeps,
  lease: TreehouseLease,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await returnLease(deps, lease, signal);
  } catch (error) {
    deps.logger.warn?.("Visible worker cleanup failed", {
      command: "treehouse",
      error: errorMessage(error),
    });
  }
}
