import type { ExecutionTarget } from "./execution";
import { HostFailure } from "./host-paths";
import {
  hostErrorSchema,
  mutationOps,
  PROTOCOL,
  UNCONFIGURED_HOST_ID,
  ReportStreamValidator,
  validateHostReply,
  validateHostRequest,
  type HostRequest,
  type HostResult,
  type ResultOp,
  type ReportFrame,
} from "./helper-protocol";
import type { StdioProcess, StdioSpawn } from "./shared";
import { serializeLedger, writesLedger } from "./ledger-queue";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const REPORT_CHUNK_BYTES = 64 * 1024;
export type HelperTransport = {
  spawnStdio?: StdioSpawn;
  signal?: AbortSignal;
  timeoutMs?: number;
  operationResults?: Readonly<Record<string, ResultOp>>;
};

export const spawnStdio: StdioSpawn = (command, options) => {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  return {
    stdin: {
      write: async (data) => {
        child.stdin.write(data);
        await child.stdin.flush();
      },
      end: async () => {
        await child.stdin.end();
      },
    },
    stdout: child.stdout as unknown as AsyncIterable<Uint8Array>,
    stderr: child.stderr as unknown as AsyncIterable<Uint8Array>,
    exited: child.exited,
    kill: () => child.kill(),
  };
};

export async function* readJsonLines(
  stream: AsyncIterable<Uint8Array>,
  maxBytes = MAX_FRAME_BYTES,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const bytes of stream) {
    try {
      pending += decoder.decode(bytes, { stream: true });
    } catch {
      throw new HostFailure("PROTOCOL_MISMATCH", "Helper frame contains invalid UTF-8.");
    }
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      if (!line || Buffer.byteLength(line) > maxBytes)
        throw new HostFailure("PROTOCOL_MISMATCH", "Invalid or oversized helper frame.");
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new HostFailure(
          "PROTOCOL_MISMATCH",
          "Helper stdout must contain only JSON Lines; remove SSH login banners.",
        );
      }
      yield value;
      pending = pending.slice(end + 1);
    }
    if (Buffer.byteLength(pending) > maxBytes)
      throw new HostFailure("PROTOCOL_MISMATCH", "Oversized helper frame.");
  }
  try {
    pending += decoder.decode();
  } catch {
    throw new HostFailure("PROTOCOL_MISMATCH", "Helper frame ends with invalid UTF-8.");
  }
  if (pending)
    throw new HostFailure("PROTOCOL_MISMATCH", "Truncated helper frame (newline required).");
}

function diagnostics(stream: AsyncIterable<Uint8Array>) {
  const result = { text: "", done: Promise.resolve() };
  result.done = (async () => {
    for await (const chunk of stream)
      if (result.text.length < 8192)
        result.text += new TextDecoder().decode(chunk).slice(0, 8192 - result.text.length);
  })().catch(() => {});
  return result;
}

const SSH_AUTH =
  /Permission denied \((?:publickey|password|keyboard-interactive)[^)]*\)|Too many authentication failures|sign_and_send_pubkey: signing failed/i;
const SSH_HOST_KEY = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i;
const SSH_OFFLINE =
  /Connection (?:refused|reset|closed|timed out)|Could not resolve hostname|No route to host|Network is unreachable|Broken pipe|Connection to .* closed|Operation timed out/i;
const HELPER_MISSING =
  /omp-orchestrator-helper.*(?:not found|not recognized)|(?:not found|not recognized).*omp-orchestrator-helper/i;

// Worktree creation, Git delivery and cleanup can legitimately outlast a short query deadline.
const OPERATION_TIMEOUTS: Partial<Record<HostRequest["op"], number>> = {
  "worker.allocate": 600_000,
  "delivery.land": 600_000,
  "delivery.push": 600_000,
  "project.create": 600_000,
  "worker.release": 600_000,
};

function transportError(request: HostRequest, stderr: string, code?: number): HostFailure {
  let kind: "SSH_AUTH" | "SSH_HOST_KEY" | "PREREQUISITE_MISSING" | "TRANSPORT_OFFLINE" =
    "TRANSPORT_OFFLINE";
  let message = `SSH helper channel unavailable${code === undefined ? "" : ` (exit ${code})`}.`;
  let remedy =
    "Check ordinary noninteractive SSH access and the installed helper; no local fallback is used.";
  if (SSH_AUTH.test(stderr)) {
    kind = "SSH_AUTH";
    message = "SSH authentication failed.";
    remedy =
      "Load keys with ssh-add, verify ordinary ssh access, or configure your own ControlMaster.";
  } else if (SSH_HOST_KEY.test(stderr)) {
    kind = "SSH_HOST_KEY";
    message = "SSH host key verification failed.";
    remedy = "Verify the machine's host key with ordinary ssh; host-key checks are never disabled.";
  } else if (HELPER_MISSING.test(stderr)) {
    kind = "PREREQUISITE_MISSING";
    message = "Remote helper is not available on the SSH login PATH.";
    remedy = "Manually install omp-orchestrator-helper (or .exe) on the target SSH login PATH.";
  }
  return new HostFailure(kind, message, {
    channel: "helper",
    effect: mutationOps[request.op] ? "unknown" : "none",
    retry: mutationOps[request.op] ? "reconcile" : "user_action",
    operationId: request.operationId,
    remedy,
  });
}

function sshCommand(
  target: Pick<ExecutionTarget, "kind" | "hostId"> & { sshTarget?: string },
  request: HostRequest,
): string[] {
  if (
    target.kind !== "ssh" ||
    !target.sshTarget ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:/%+[\]-]*$/.test(target.sshTarget)
  )
    throw new HostFailure(
      "INVALID_REQUEST",
      "SSH target must be a saved non-option OpenSSH target, not shell syntax.",
      { channel: "controller", retry: "never" },
    );
  if (request.expectedHostId && request.expectedHostId !== target.hostId)
    throw new HostFailure(
      "HOST_MISMATCH",
      "Request host does not match its immutable execution target.",
      { channel: "controller" },
    );
  return [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    target.sshTarget,
    "omp-orchestrator-helper --stdio-v1",
  ];
}

class HelperRefusal extends HostFailure {}

async function exchange<T>(
  target: Pick<ExecutionTarget, "kind" | "hostId"> & { sshTarget?: string },
  request: HostRequest,
  options: HelperTransport,
  consume: (process: StdioProcess) => Promise<T>,
): Promise<T> {
  const command = sshCommand(target, request);
  if (options.signal?.aborted)
    throw new HostFailure("TIMEOUT", "Helper request cancelled before transmission.", {
      channel: "controller",
      retry: "read_only",
    });
  let child: StdioProcess;
  try {
    child = (options.spawnStdio ?? spawnStdio)(command, {});
  } catch {
    throw new HostFailure("PREREQUISITE_MISSING", "OpenSSH executable could not be started.", {
      channel: "controller",
      remedy: "Manually install OpenSSH and make ssh (ssh.exe on Windows) available on PATH.",
    });
  }
  const stderr = diagnostics(child.stderr);
  let timer: NodeJS.Timeout | undefined;
  let abort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    abort = () => {
      child.kill();
      reject(
        new HostFailure(
          "TIMEOUT",
          "Helper request deadline/cancellation reached; remote mutations may still be running.",
          {
            channel: "helper",
            effect: mutationOps[request.op] ? "unknown" : "none",
            retry: mutationOps[request.op] ? "reconcile" : "read_only",
            operationId: request.operationId,
          },
        ),
      );
    };
    timer = setTimeout(abort, options.timeoutMs ?? OPERATION_TIMEOUTS[request.op] ?? 120_000);
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        try {
          await child.stdin.write(`${JSON.stringify(request)}\n`);
          await child.stdin.end();
          const result = await consume(child);
          const code = await child.exited;
          if (code !== 0) {
            await stderr.done;
            throw transportError(request, stderr.text, code);
          }
          return result;
        } catch (error) {
          // stdout can close before SSH publishes its exit status and diagnostic stream.
          let code: number | undefined;
          let exitTimer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.all([
                child.exited.then((value) => {
                  code = value;
                }),
                stderr.done,
              ]),
              new Promise<void>((resolve) => {
                exitTimer = setTimeout(resolve, 100);
              }),
            ]);
          } catch {
            // A failed exit observation does not prove the channel completed successfully.
          } finally {
            clearTimeout(exitTimer);
          }
          if (code === undefined) child.kill();
          // A validated refusal is a complete helper response, not a broken stream (helper exits 1).
          if (error instanceof HelperRefusal) throw error;
          if (
            (code !== undefined && code !== 0) ||
            [SSH_AUTH, SSH_HOST_KEY, SSH_OFFLINE, HELPER_MISSING].some((pattern) =>
              pattern.test(stderr.text),
            )
          )
            throw transportError(request, stderr.text, code);
          if (error instanceof HostFailure) {
            if (error.detail.code === "TRANSPORT_OFFLINE")
              throw transportError(request, stderr.text, code);
            if (mutationOps[request.op] && error.detail.code === "PROTOCOL_MISMATCH")
              throw new HostFailure(error.detail.code, error.detail.message, {
                ...error.detail,
                effect: "unknown",
                retry: "reconcile",
                operationId: request.operationId,
              });
            throw error;
          }
          throw transportError(request, stderr.text, code);
        }
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function refusal(request: HostRequest, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const reply = value as Record<string, unknown>;
  if (reply.ok !== false) return;
  if (reply.protocol !== PROTOCOL || reply.version !== 1 || reply.requestId !== request.requestId)
    throw new HostFailure(
      "PROTOCOL_MISMATCH",
      "Helper refusal has an unexpected protocol/request identity.",
    );
  const error = hostErrorSchema.parse(reply.error);
  const unconfigured =
    reply.hostId === UNCONFIGURED_HOST_ID &&
    error.code === "PREREQUISITE_MISSING" &&
    error.effect === "none";
  if (
    reply.hostId !== request.expectedHostId &&
    request.expectedHostId &&
    error.code !== "HOST_MISMATCH" &&
    !unconfigured
  )
    throw new HostFailure(
      "HOST_MISMATCH",
      "Helper host identity changed; restore the original machine binding.",
    );
  throw new HelperRefusal(error.code, error.message, error);
}

export async function callHelper<Op extends ResultOp>(
  target: Pick<ExecutionTarget, "kind" | "hostId"> & { sshTarget?: string },
  request: HostRequest<Op>,
  options: HelperTransport = {},
): Promise<HostResult<Op>> {
  if (writesLedger(request.op))
    return serializeLedger(`ssh:${target.hostId}:${request.controllerId}`, () =>
      callSerializedHelper(target, request, options),
    );
  return callSerializedHelper(target, request, options);
}

async function callSerializedHelper<Op extends ResultOp>(
  target: Pick<ExecutionTarget, "kind" | "hostId"> & { sshTarget?: string },
  request: HostRequest<Op>,
  options: HelperTransport,
): Promise<HostResult<Op>> {
  const wireRequest = validateHostRequest(request);
  return exchange(target, wireRequest, options, async (child) => {
    let reply: unknown;
    let count = 0;
    for await (const frame of readJsonLines(child.stdout)) {
      reply = frame;
      count++;
    }
    if (count !== 1) throw transportError(wireRequest, "");
    refusal(wireRequest, reply);
    try {
      const validated = validateHostReply(request, reply, options.operationResults);
      if (!validated.ok)
        throw new HostFailure(validated.error.code, validated.error.message, validated.error);
      return validated.result;
    } catch (error) {
      if (error instanceof HostFailure) throw error;
      const hostId =
        reply && typeof reply === "object" && "hostId" in reply && typeof reply.hostId === "string"
          ? reply.hostId
          : undefined;
      throw new HostFailure(
        hostId && request.expectedHostId && hostId !== request.expectedHostId
          ? "HOST_MISMATCH"
          : "PROTOCOL_MISMATCH",
        "Helper returned an invalid or mismatched reply.",
        {
          effect: mutationOps[request.op] ? "unknown" : "none",
          retry: mutationOps[request.op] ? "reconcile" : "user_action",
          operationId: request.operationId,
        },
      );
    }
  });
}

export async function readReportStream(
  target: Pick<ExecutionTarget, "kind" | "hostId"> & { sshTarget?: string },
  request: HostRequest<"report.read">,
  consume: (frame: ReportFrame) => void | Promise<void>,
  options: HelperTransport = {},
): Promise<Extract<ReportFrame, { type: "end" }>> {
  validateHostRequest(request);
  return exchange(target, request, options, async (child) => {
    const validator = new ReportStreamValidator(request);
    let end: Extract<ReportFrame, { type: "end" }> | undefined;
    for await (const frame of readJsonLines(child.stdout)) {
      refusal(request, frame);
      let valid: ReportFrame;
      try {
        valid = validator.accept(frame);
      } catch {
        throw new HostFailure(
          "REPORT_INVALID",
          "Report stream failed identity, ordering, UTF-8, size or checksum validation; retain staged report.",
        );
      }
      await consume(valid);
      if (valid.type === "end") end = valid;
    }
    try {
      validator.finish();
    } catch {
      throw new HostFailure(
        "REPORT_INVALID",
        "Report transfer was truncated; retain staged report and discard only the local temporary export.",
      );
    }
    return end!;
  });
}
