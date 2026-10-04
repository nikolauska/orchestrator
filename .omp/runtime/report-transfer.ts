import { zod as z } from "@oh-my-pi/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { digestSchema, idSchema, shaSchema, timestampSchema } from "./execution";
import { streamHostReport, type HostRuntime } from "./host";
import { HostFailure } from "./host-paths";
import {
  PROTOCOL,
  ReportStreamValidator,
  type ReportReceipt,
  type HostRequest,
} from "./helper-protocol";
import { readReportStream, type HelperTransport } from "./remote";
import type { WorkerRecord } from "./shared";

export const reportProvenanceSchema = z
  .object({
    version: z.literal(1),
    controllerId: idSchema,
    launchId: idSchema,
    workerName: z.string().min(1),
    namespace: z.string().min(1),
    machineId: z.string().min(1),
    sshTarget: z.string().min(1).optional(),
    session: z.string().min(1),
    hostId: idSchema,
    os: z.enum(["linux", "darwin", "win32"]),
    sourceHead: shaSchema.optional(),
    sourcePath: z.string().min(1),
    collectedAt: timestampSchema,
    sha256: digestSchema,
    byteCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ReportProvenance = z.infer<typeof reportProvenanceSchema>;
export const provenancePath = (path: string) => `${path.slice(0, -3)}.meta.json`;

async function regularBytes(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new HostFailure("DESTINATION_CONFLICT", `Archive is not a regular file: ${path}`);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
      throw new HostFailure("DESTINATION_CONFLICT", `Archive identity changed: ${path}`);
    const bytes = await handle.readFile();
    const after = await lstat(path);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new HostFailure("DESTINATION_CONFLICT", `Archive changed: ${path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}
const missing = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
async function existing(path: string): Promise<Buffer | undefined> {
  try {
    return await regularBytes(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}

export async function readProvenance(
  path: string,
): Promise<{ provenance?: ReportProvenance; issues?: string[] }> {
  try {
    const bytes = await existing(provenancePath(path));
    return bytes
      ? {
          provenance: reportProvenanceSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          ),
        }
      : {};
  } catch {
    return { issues: ["Report provenance sidecar is unreadable or invalid"] };
  }
}

async function publish(
  temp: string,
  path: string,
  same: (bytes: Buffer) => boolean,
): Promise<void> {
  try {
    // A rename may overwrite on POSIX. A same-volume hard link publishes exclusively on every host.
    await link(temp, path);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
    if (!same(await regularBytes(path)))
      throw new HostFailure("DESTINATION_CONFLICT", `Existing archive differs: ${path}`);
  }
}

export async function collectReport(
  record: WorkerRecord,
  operationId: string,
  options: { runtime?: HostRuntime; transport?: HelperTransport } = {},
): Promise<ReportReceipt> {
  const target = record.target;
  if (
    !target ||
    target.kind === "unresolved_local" ||
    !record.report_path ||
    !record.report_source_path
  )
    throw new HostFailure(
      "REPORT_INVALID",
      "Report requires bound host, staged source and local destination",
    );
  const path = record.report_path;
  const metaPath = provenancePath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const metaTemp = `${metaPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    const request: HostRequest<"report.read"> = {
      protocol: PROTOCOL,
      version: 1,
      requestId: randomUUID(),
      controllerId: record.controller_id!,
      expectedHostId: target.hostId,
      op: "report.read",
      args: { launchId: record.launch_id! },
    };
    const validator = new ReportStreamValidator(request);
    let end: { sha256: string; byteCount: number } | undefined;
    try {
      const consume = async (value: unknown) => {
        const frame = validator.accept(value);
        if (frame.type === "chunk") {
          const bytes = Buffer.from(frame.bytesBase64, "base64");
          let written = 0;
          try {
            while (written < bytes.length) {
              const result = await handle.write(bytes, written, bytes.length - written);
              if (!result.bytesWritten) throw new Error("Report write made no progress");
              written += result.bytesWritten;
            }
          } catch {
            throw new HostFailure(
              "COMMAND_FAILED",
              "Controller report write failed; retain valid staging",
              { channel: "controller" },
            );
          }
        } else if (frame.type === "end") end = frame;
      };
      if (target.kind === "local") {
        if (!options.runtime) throw new Error("Local report runtime missing");
        for await (const frame of streamHostReport(options.runtime, request)) await consume(frame);
      } else await readReportStream(target, request, consume, options.transport);
      validator.finish();
      try {
        await handle.sync();
      } catch {
        throw new HostFailure("COMMAND_FAILED", "Controller report sync failed; retain staging", {
          channel: "controller",
        });
      }
    } catch (error) {
      if (error instanceof HostFailure) throw error;
      throw new HostFailure(
        "REPORT_INVALID",
        "Report stream is invalid or unavailable; staging retained",
      );
    } finally {
      await handle.close();
    }
    if (!end) throw new HostFailure("REPORT_INVALID", "Report export is incomplete");
    const matches = (bytes: Buffer) =>
      bytes.length === end!.byteCount &&
      createHash("sha256").update(bytes).digest("hex") === end!.sha256;
    const priorReport = await existing(path);
    if (priorReport && !matches(priorReport))
      throw new HostFailure("DESTINATION_CONFLICT", `Existing report differs: ${path}`);
    const provenance: ReportProvenance = reportProvenanceSchema.parse({
      version: 1,
      controllerId: record.controller_id,
      launchId: record.launch_id,
      workerName: record.name,
      namespace: record.scope === "independent" ? "_independent" : record.project,
      machineId: target.machineId,
      ...(target.kind === "ssh" ? { sshTarget: target.sshTarget } : {}),
      session: target.session,
      hostId: target.hostId,
      os: target.os,
      ...(record.source_head ? { sourceHead: record.source_head } : {}),
      sourcePath: record.report_source_path,
      collectedAt: record.report_receipt?.collectedAt ?? new Date().toISOString(),
      sha256: end.sha256,
      byteCount: end.byteCount,
    });
    const priorMeta = await existing(metaPath);
    if (priorMeta) {
      let prior: ReportProvenance;
      try {
        prior = reportProvenanceSchema.parse(JSON.parse(priorMeta.toString("utf8")));
      } catch {
        throw new HostFailure(
          "DESTINATION_CONFLICT",
          `Existing provenance is invalid: ${metaPath}`,
        );
      }
      if (record.report_receipt && prior.collectedAt !== record.report_receipt.collectedAt)
        throw new HostFailure(
          "DESTINATION_CONFLICT",
          `Existing provenance differs from its durable receipt: ${metaPath}`,
        );
      provenance.collectedAt = prior.collectedAt;
      if (
        Object.keys(provenance).some(
          (key) =>
            provenance[key as keyof ReportProvenance] !== prior[key as keyof ReportProvenance],
        )
      )
        throw new HostFailure("DESTINATION_CONFLICT", `Existing provenance differs: ${metaPath}`);
    }
    const metadata = Buffer.from(JSON.stringify(provenance, null, 2) + "\n");
    const metaHandle = await open(metaTemp, "wx", 0o600);
    try {
      await metaHandle.writeFile(metadata);
      await metaHandle.sync();
    } finally {
      await metaHandle.close();
    }
    await publish(temp, path, matches);
    await publish(metaTemp, metaPath, (bytes) => bytes.equals(metadata));
    if (process.platform !== "win32") {
      // Windows has no portable directory-fsync handle; synced files are closed before publication.
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return {
      id: record.report_receipt?.id ?? operationId,
      operationId,
      launchId: record.launch_id!,
      localPath: path,
      provenancePath: metaPath,
      sha256: end.sha256,
      byteCount: end.byteCount,
      collectedAt: provenance.collectedAt,
    };
  } finally {
    await Promise.all(
      [temp, metaTemp].map((path) =>
        unlink(path).catch((error) => {
          if (!missing(error)) throw error;
        }),
      ),
    );
  }
}
