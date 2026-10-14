import { randomUUID } from "node:crypto";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
  createHostRuntime,
  dispatchHostRequest,
  helperConfigurationPath,
  loadHelperConfiguration,
  nativeExec,
  reconcileHostOperation,
  streamHostReport,
  type HostRuntime,
} from "./host";
import { HostFailure } from "./host-paths";
import {
  PROTOCOL,
  UNCONFIGURED_HOST_ID,
  validateHostRequest,
  type HostError,
  type OperationView,
} from "./helper-protocol";
import { MAX_FRAME_BYTES, readJsonLines } from "./remote";

export async function reconcileOperation(
  runtime: HostRuntime,
  controllerId: string,
  operationId: string,
): Promise<OperationView> {
  return reconcileHostOperation(runtime, controllerId, operationId);
}

export type HelperIO = {
  stdin: AsyncIterable<Uint8Array>;
  write(line: string): void | Promise<void>;
  diagnostic(message: string): void;
};

export async function main(
  args = process.argv.slice(2),
  io: HelperIO = {
    stdin: Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>,
    // Await the stream callback: Bun.write(stdout) can short-write when an SSH pipe backpressures.
    write: (line) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (error) => (error ? reject(error) : resolve()));
      }),
    diagnostic: (message) => {
      console.error(message);
    },
  },
  suppliedRuntime?: HostRuntime,
): Promise<number> {
  if (args.length !== 1 || args[0] !== "--stdio-v1") {
    io.diagnostic(
      "Usage: omp-orchestrator-helper --stdio-v1\nOne version 1 JSON Lines request on stdin; replies only on stdout. Manually provision ~/.omp/orchestrator/helper.json or OMP_ORCHESTRATOR_HELPER_CONFIG. No tools, credentials or configuration are installed/copied.",
    );
    return 2;
  }
  let requestId: string = randomUUID();
  let hostId = suppliedRuntime?.configuration.hostId ?? UNCONFIGURED_HOST_ID;
  let operationId: string | undefined;
  try {
    const frames = [];
    for await (const frame of readJsonLines(io.stdin, MAX_FRAME_BYTES)) {
      frames.push(frame);
      if (frames.length > 1)
        throw new HostFailure(
          "INVALID_REQUEST",
          "Exactly one request per helper process is required.",
          { retry: "never" },
        );
    }
    if (frames.length !== 1)
      throw new HostFailure("INVALID_REQUEST", "A single newline-terminated request is required.", {
        retry: "never",
      });
    const raw = frames[0];
    if (raw && typeof raw === "object" && "requestId" in raw && typeof raw.requestId === "string")
      requestId = raw.requestId;
    let request;
    try {
      request = validateHostRequest(raw);
    } catch {
      throw new HostFailure(
        "INVALID_REQUEST",
        "Request does not match the strict version 1 domain operation schema.",
        { retry: "never" },
      );
    }
    operationId = request.operationId;
    const configPath = helperConfigurationPath();
    // Keep stdout JSON-only and leave the host untouched: the console transport writes fd 1 and
    // the default file transport creates ~/.omp/logs.
    if (!suppliedRuntime) logger.setTransports({ console: false, file: false });
    const runtime =
      suppliedRuntime ??
      createHostRuntime(
        await loadHelperConfiguration(configPath),
        { exec: nativeExec, notify: () => {}, logger },
        { configurationPath: configPath, installationPath: process.execPath },
      );
    hostId = runtime.configuration.hostId;
    if (request.op === "report.read") {
      for await (const frame of streamHostReport(runtime, request))
        await io.write(`${JSON.stringify(frame)}\n`);
      return 0;
    }
    const reply = await dispatchHostRequest(runtime, request);
    const line = `${JSON.stringify(reply)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
      throw new HostFailure(
        "PROTOCOL_MISMATCH",
        "Host result exceeds the advertised regular-frame limit; reconcile a mutation by its operation ID.",
        {
          effect: operationId ? "unknown" : "none",
          retry: operationId ? "reconcile" : "user_action",
        },
      );
    await io.write(line);
    return reply.ok ? 0 : 1;
  } catch (error) {
    const failure: HostError =
      error instanceof HostFailure
        ? error.detail
        : {
            code: "COMMAND_FAILED",
            message:
              "Helper could not complete the request; inspect the provisioned roots/configuration and retained operation ledger.",
            channel: "helper",
            effect: operationId ? "unknown" : "none",
            retry: operationId ? "reconcile" : "user_action",
          };
    await io.write(
      `${JSON.stringify({ protocol: PROTOCOL, version: 1, requestId, hostId, ok: false, error: { ...failure, ...(operationId ? { operationId } : {}) } })}\n`,
    );
    return failure.code === "INVALID_REQUEST" || failure.code === "PROTOCOL_MISMATCH" ? 2 : 1;
  }
}
