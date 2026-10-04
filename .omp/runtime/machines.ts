import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { zod as z } from "@oh-my-pi/pi-coding-agent";
import {
  machineBindingSchema,
  targetKey,
  UNCONFIGURED_HOST_ID,
  validateExecutionTarget,
  type ExecutionTarget,
  type MachineBinding,
} from "./execution";
import {
  PROTOCOL,
  type HostArgs,
  type HostError,
  type HostRequest,
  type HostResult,
  type HelloResult,
  type PreflightResult,
  type ResultOp,
} from "./helper-protocol";
import { createLocalHostRuntime, dispatchHostRequest, type HostRuntime } from "./host";
import { HostFailure } from "./host-paths";
import { ensureIntegration, resolveLocalHerdrTarget, WORKER_CONFIG } from "./herdr";
import { callHelper } from "./remote";
import { errorMessage, type ToolAPI } from "./shared";
import type { ResolvedOmpContext } from "./omp";

export type Machine = {
  machineId: string;
  label: string;
  enabled: boolean;
  sshTarget?: string;
  session?: string;
};
export type ResolvedMachine = {
  machine: Machine;
  host: HelloResult;
  binding?: MachineBinding;
  runtime?: HostRuntime;
};
export type MachineOptions = {
  controllerId: string;
  binding?: MachineBinding;
  signal?: AbortSignal;
};
export type MachineCheck = {
  machine: Machine;
  ready: boolean;
  target?: ExecutionTarget;
  preflight?: PreflightResult;
  herdr: { state: "online" | "offline" | "attention"; error?: HostError };
  helper: { state: "online" | "offline" | "attention"; error?: HostError };
  errors: HostError[];
};
const profileSchema = z.object({
  id: z
    .string()
    .min(1)
    .refine((value) => value !== "local" && !value.startsWith("-")),
  label: z.string().min(1),
  target: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("-")),
  session: z.string().min(1),
  enabled: z.boolean(),
});
const local: Machine = { machineId: "local", label: "Local", enabled: true };
const runtimes = new WeakMap<ToolAPI, Promise<HostRuntime>>();

export function machineError(error: unknown, channel: HostError["channel"]): HostError {
  if (error instanceof HostFailure) return error.detail;
  if (error && typeof error === "object" && "code" in error && "effect" in error)
    return error as HostError;
  return {
    code: "TRANSPORT_OFFLINE",
    message: errorMessage(error).slice(0, 4096),
    channel,
    effect: "none",
    retry: "read_only",
  };
}
function connection(error: HostError): "offline" | "attention" {
  return ["TRANSPORT_OFFLINE", "TIMEOUT"].includes(error.code) ? "offline" : "attention";
}

export async function listMachines(pi: ToolAPI, signal?: AbortSignal): Promise<Machine[]> {
  signal?.throwIfAborted();
  const result = await pi.exec("herdr", ["machine", "list", "--json"], { signal, timeout: 10_000 });
  signal?.throwIfAborted();
  if (result.code !== 0)
    throw new HostFailure("COMMAND_FAILED", "Cannot read Herdr saved machine profiles.", {
      channel: "herdr",
      remedy: "Check herdr machine list --json on the controller; no machine was changed.",
    });
  let profiles: z.infer<typeof profileSchema>[];
  try {
    profiles = z.array(profileSchema).parse(JSON.parse(result.stdout));
  } catch {
    throw new HostFailure("PROTOCOL_MISMATCH", "Invalid Herdr machine list JSON.", {
      channel: "herdr",
    });
  }
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new HostFailure("PROTOCOL_MISMATCH", "Herdr returned duplicate machine IDs.", {
      channel: "herdr",
    });
  return [
    local,
    ...profiles.map((profile) => ({
      machineId: profile.id,
      label: profile.label,
      enabled: profile.enabled,
      sshTarget: profile.target,
      session: profile.session,
    })),
  ];
}

export function selectMachine(machines: Machine[], selector = "local"): Machine {
  const exact = machines.find((machine) => machine.machineId === selector);
  const matches = exact ? [exact] : machines.filter((machine) => machine.label === selector);
  if (matches.length !== 1)
    throw new HostFailure(
      "MACHINE_NOT_FOUND",
      matches.length
        ? `Ambiguous machine label: ${selector}; use its ID.`
        : `Unknown Herdr machine: ${selector}.`,
      { channel: "controller" },
    );
  return matches[0];
}

/** Labels are mutable metadata; only the saved routing and helper identity bind work. */
export function validateBinding(machine: Machine, binding?: MachineBinding, hostId?: string): void {
  if (!machine.enabled)
    throw new HostFailure("MACHINE_DISABLED", `Herdr machine ${machine.machineId} is disabled.`, {
      channel: "herdr",
    });
  if (
    binding &&
    (binding.machineId !== machine.machineId ||
      binding.sshTarget !== machine.sshTarget ||
      binding.session !== machine.session)
  )
    throw new HostFailure(
      "PROFILE_CHANGED",
      `Herdr machine ${machine.machineId} no longer matches its saved SSH target/session.`,
      {
        channel: "herdr",
        remedy: "Restore the original profile; re-register only for future launches.",
      },
    );
  if (binding && hostId && binding.hostId !== hostId)
    throw new HostFailure(
      "HOST_MISMATCH",
      "Helper hostId differs from the saved machine binding.",
      { remedy: "Restore the original helper identity; retained workers cannot move hosts." },
    );
}

async function localRuntime(pi: ToolAPI): Promise<HostRuntime> {
  if (pi.localHostRuntime) return pi.localHostRuntime;
  let runtime = runtimes.get(pi);
  if (!runtime) {
    runtime = createLocalHostRuntime(pi, { cwd: pi.cwd, neutralRoot: pi.neutralRoot });
    runtimes.set(pi, runtime);
    runtime.catch(() => runtimes.delete(pi));
  }
  return runtime;
}

export async function resolveMachine(
  pi: ToolAPI,
  selector: string | undefined,
  options: MachineOptions,
): Promise<ResolvedMachine> {
  const machine =
    !selector || selector === "local"
      ? local
      : selectMachine(await listMachines(pi, options.signal), selector);
  validateBinding(machine, options.binding);
  const runtime = machine.machineId === "local" ? await localRuntime(pi) : undefined;
  const request: HostRequest<"hello"> = {
    protocol: PROTOCOL,
    version: 1,
    requestId: randomUUID(),
    controllerId: options.controllerId,
    op: "hello",
    args: { supportedVersions: [1] },
    ...(options.binding ? { expectedHostId: options.binding.hostId } : {}),
  };
  let host: HelloResult;
  if (runtime) {
    const reply = await dispatchHostRequest(runtime, request);
    if (!reply.ok) throw new HostFailure(reply.error.code, reply.error.message, reply.error);
    host = reply.result;
  } else {
    host = await callHelper(
      {
        kind: "ssh",
        sshTarget: machine.sshTarget,
        hostId: options.binding?.hostId ?? UNCONFIGURED_HOST_ID,
      },
      request,
      { spawnStdio: pi.spawnStdio, signal: options.signal },
    );
  }
  validateBinding(machine, options.binding, host.hostId);
  if (host.hostId === UNCONFIGURED_HOST_ID)
    throw new HostFailure(
      "PREREQUISITE_MISSING",
      "Provision a persistent helper hostId before selecting this machine.",
    );
  return {
    machine,
    host,
    ...(runtime
      ? { runtime }
      : {
          binding: machineBindingSchema.parse({
            machineId: machine.machineId,
            sshTarget: machine.sshTarget,
            session: machine.session,
            hostId: host.hostId,
          }),
        }),
  };
}

export async function callMachine<Op extends ResultOp>(
  pi: ToolAPI,
  resolved: ResolvedMachine,
  op: Op,
  args: HostArgs[Op],
  options: MachineOptions & { operationId?: string },
): Promise<HostResult<Op>> {
  options.signal?.throwIfAborted();
  if (resolved.binding) {
    const current = selectMachine(
      await listMachines(pi, options.signal),
      resolved.machine.machineId,
    );
    validateBinding(current, resolved.binding);
  }
  const request = {
    protocol: PROTOCOL,
    version: 1,
    requestId: randomUUID(),
    controllerId: options.controllerId,
    expectedHostId: resolved.host.hostId,
    op,
    args,
    ...(options.operationId ? { operationId: options.operationId } : {}),
  } as HostRequest<Op>;
  if (!resolved.runtime)
    return callHelper(
      { kind: "ssh", sshTarget: resolved.machine.sshTarget, hostId: resolved.host.hostId },
      request,
      { spawnStdio: pi.spawnStdio, signal: options.signal },
    );
  const reply = await dispatchHostRequest(resolved.runtime, request);
  options.signal?.throwIfAborted();
  if (!reply.ok) throw new HostFailure(reply.error.code, reply.error.message, reply.error);
  return reply.result;
}

export async function statusMachine(
  pi: ToolAPI,
  machine: Machine,
  signal?: AbortSignal,
): Promise<MachineCheck["herdr"]> {
  try {
    validateBinding(machine);
    const args =
      machine.machineId === "local"
        ? ["status", "server", "--json"]
        : ["machine", "status", machine.machineId, "--json"];
    const result = await pi.exec("herdr", args, { signal, timeout: 15_000 });
    signal?.throwIfAborted();
    const value = JSON.parse(result.stdout);
    if (machine.machineId === "local") {
      if (result.code === 0 && value.running === true) return { state: "online" };
    } else {
      const row = z
        .array(z.object({ id: z.string(), status: z.string() }))
        .parse(value)
        .find((row) => row.id === machine.machineId);
      if (row?.status === "reachable") return { state: "online" };
      if (row?.status === "auth required")
        throw new HostFailure("SSH_AUTH", "Herdr SSH authentication requires user action.", {
          channel: "herdr",
          remedy:
            "Authenticate using Herdr/OpenSSH manually; no trust or credentials were changed.",
        });
    }
    throw new HostFailure(
      "TRANSPORT_OFFLINE",
      `Herdr machine ${machine.machineId} is not reachable.`,
      { channel: "herdr", retry: "read_only" },
    );
  } catch (error) {
    signal?.throwIfAborted();
    const detail = machineError(error, "herdr");
    return { state: connection(detail), error: detail };
  }
}

export type MachinePreflight =
  | Omit<Extract<HostArgs["preflight"], { scope: "project" }>, "requiredOverlaySha256">
  | Omit<Extract<HostArgs["preflight"], { scope: "independent" }>, "requiredOverlaySha256">;
async function prepareMachine(
  pi: ToolAPI,
  resolved: ResolvedMachine,
  options: MachineOptions & { preflight?: MachinePreflight },
): Promise<{ target: ExecutionTarget; preflight: PreflightResult }> {
  const requiredOverlaySha256 = createHash("sha256")
    .update(await readFile(WORKER_CONFIG))
    .digest("hex");
  const preflight = await callMachine(
    pi,
    resolved,
    "preflight",
    {
      ...(options.preflight ?? { scope: "independent" }),
      requiredOverlaySha256,
    } as HostArgs["preflight"],
    options,
  );
  if (preflight.host.hostId !== resolved.host.hostId)
    throw new HostFailure(
      "HOST_MISMATCH",
      "Preflight host identity differs from its helper handshake.",
    );
  const base = {
    hostId: preflight.host.hostId,
    os: preflight.host.os,
    arch: preflight.host.arch,
    pathStyle: preflight.host.os === "win32" ? "win32" : "posix",
    workerConfig: { path: preflight.context.overlayPath, sha256: preflight.overlaySha256 },
    runtimeRoot: preflight.runtimeRoot,
    neutralRoot: preflight.neutralRoot,
    ...(preflight.context.ompProfile ? { ompProfile: preflight.context.ompProfile } : {}),
  };
  let session = resolved.machine.session;
  if (resolved.runtime)
    session = (
      await resolveLocalHerdrTarget(
        pi,
        {
          hostId: base.hostId,
          runtimeRoot: base.runtimeRoot.path,
          neutralRoot: base.neutralRoot.path,
        },
        options.signal,
      )
    ).session;
  const target = validateExecutionTarget({
    ...base,
    session,
    kind: resolved.runtime ? "local" : "ssh",
    machineId: resolved.machine.machineId,
    ...(resolved.binding ? { sshTarget: resolved.binding.sshTarget } : {}),
  });
  return { target, preflight };
}

/** Catalog/quota inspection needs the helper context, not a ready visible terminal. */
export async function resolveMachineOmpContext(
  pi: ToolAPI,
  machine: string,
  options: MachineOptions,
): Promise<ResolvedOmpContext> {
  const resolved = await resolveMachine(pi, machine, options);
  const requiredOverlaySha256 = createHash("sha256")
    .update(await readFile(WORKER_CONFIG))
    .digest("hex");
  const { context } = await callMachine(
    pi,
    resolved,
    "omp.context",
    { requiredOverlaySha256 },
    options,
  );
  const base = {
    hostId: resolved.host.hostId,
    os: resolved.host.os,
    workerConfig: { path: context.overlayPath, sha256: context.overlaySha256 },
    ...(context.ompProfile ? { ompProfile: context.ompProfile } : {}),
  };
  const target: ResolvedOmpContext["target"] = resolved.binding
    ? {
        ...base,
        kind: "ssh",
        machineId: resolved.machine.machineId,
        sshTarget: resolved.binding.sshTarget,
        session: resolved.binding.session,
      }
    : { ...base, kind: "local", machineId: "local", session: null };
  return {
    target,
    context,
    controllerId: options.controllerId,
    ...(resolved.runtime ? { runtime: resolved.runtime } : {}),
  };
}

export async function checkMachine(
  pi: ToolAPI,
  selector: string | undefined,
  options: MachineOptions & { preflight?: MachinePreflight },
): Promise<MachineCheck> {
  const machine =
    !selector || selector === "local"
      ? local
      : selectMachine(await listMachines(pi, options.signal), selector);
  const herdr = await statusMachine(pi, machine, options.signal);
  const check: MachineCheck = {
    machine,
    ready: false,
    herdr,
    helper: { state: "offline" },
    errors: herdr.error ? [herdr.error] : [],
  };
  try {
    const resolved = await resolveMachine(pi, machine.machineId, options);
    const { target, preflight } = await prepareMachine(pi, resolved, options);
    check.preflight = preflight;
    check.target = target;
    check.helper = { state: "online" };
  } catch (error) {
    options.signal?.throwIfAborted();
    const detail = machineError(error, "helper");
    check.helper = { state: connection(detail), error: detail };
    check.errors.push(detail);
  }
  if (check.target && check.preflight) {
    try {
      const integration = check.preflight.tools.find(
        (tool) => tool.name === "herdr-omp-integration",
      );
      await ensureIntegration(pi, check.target, {
        signal: options.signal,
        ...(integration
          ? { integration: { targetKey: targetKey(check.target), check: integration } }
          : {}),
      });
      check.herdr = { state: "online" };
      check.errors = check.errors.filter((error) => error !== herdr.error);
    } catch (error) {
      options.signal?.throwIfAborted();
      const detail = machineError(error, "herdr");
      check.herdr = { state: connection(detail), error: detail };
      check.errors.push(detail);
    }
  }
  check.ready = check.herdr.state === "online" && check.helper.state === "online";
  return check;
}
