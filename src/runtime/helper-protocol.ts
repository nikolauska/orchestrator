import * as z from "@oh-my-pi/omptype/zod";
import { createHash } from "node:crypto";
import {
  configurationContextSchema,
  digestSchema,
  hostPathSchema,
  idSchema,
  nativeStringSchema,
  shaSchema,
  timestampSchema,
  UNCONFIGURED_HOST_ID,
} from "./execution";

export const PROTOCOL = "omp-orchestrator-helper";
export const PROTOCOL_VERSION = 1;
export { UNCONFIGURED_HOST_ID } from "./execution";
export type Id = string;
export type Sha = string;
export type Digest = string;
export type Timestamp = string;
export type Scope = "project" | "independent";
const str = nativeStringSchema;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const strings = z.array(str);
const map = z.record(z.string(), z.string());
export const hostErrorSchema = z
  .object({
    code: z.enum([
      "INVALID_REQUEST",
      "PROTOCOL_MISMATCH",
      "HOST_MISMATCH",
      "MACHINE_NOT_FOUND",
      "MACHINE_DISABLED",
      "PROFILE_CHANGED",
      "TRANSPORT_OFFLINE",
      "SSH_AUTH",
      "SSH_HOST_KEY",
      "TIMEOUT",
      "PREREQUISITE_MISSING",
      "CONFIG_MISMATCH",
      "CAPABILITY_MISSING",
      "PATH_INVALID",
      "PATH_FORBIDDEN",
      "RESOURCE_NOT_FOUND",
      "LEASE_MISMATCH",
      "AGENT_MISMATCH",
      "MODEL_UNAVAILABLE",
      "TARGET_DIRTY",
      "BRANCH_CHANGED",
      "REBASE_CONFLICT",
      "REPORT_INVALID",
      "REPORT_CHANGED",
      "DESTINATION_CONFLICT",
      "COMMAND_FAILED",
      "OPERATION_UNCERTAIN",
      "LOCK_BUSY",
      "OPERATION_NOT_STARTED",
    ]),
    message: str.max(4096),
    channel: z.enum(["controller", "herdr", "helper"]),
    effect: z.enum(["none", "confirmed", "unknown"]),
    retry: z.enum(["read_only", "reconcile", "user_action", "never"]),
    operationId: idSchema.optional(),
    remedy: str.max(4096).optional(),
  })
  .strict();
export type HostError = z.infer<typeof hostErrorSchema>;
export const agentBindingSchema = z
  .object({
    revision: count.refine((v) => v > 0),
    identity: z.literal("omp"),
    agentName: str,
    session: str,
    workspaceId: str,
    tabId: str,
    paneId: str,
    cwd: hostPathSchema,
    sessionPath: str.optional(),
    incarnation: str.optional(),
    completionSeq: count.optional(),
  })
  .strict();
export type AgentBinding = z.infer<typeof agentBindingSchema>;
export const reportReceiptSchema = z
  .object({
    id: idSchema,
    operationId: idSchema,
    launchId: idSchema,
    localPath: str,
    provenancePath: str,
    sha256: digestSchema,
    byteCount: count,
    collectedAt: timestampSchema,
  })
  .strict();
export type ReportReceipt = z.infer<typeof reportReceiptSchema>;
const deliveryBase = {
  id: idSchema,
  operationId: idSchema,
  launchId: idSchema,
  workerHead: shaSchema,
  deliveryBase: shaSchema,
  confirmedAt: timestampSchema,
};
export const deliveryReceiptSchema = z.union([
  z
    .object({
      ...deliveryBase,
      kind: z.literal("merged"),
      project: hostPathSchema,
      branch: str,
      targetHead: shaSchema,
    })
    .strict(),
  z
    .object({
      ...deliveryBase,
      kind: z.literal("pushed"),
      originIdentity: str,
      ref: str,
      targetHead: shaSchema,
    })
    .strict(),
  z
    .object({
      ...deliveryBase,
      kind: z.literal("no_changes"),
      project: hostPathSchema,
      branch: str.optional(),
    })
    .strict(),
]);
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;
export const leaseSchema = z
  .object({ path: str, pathKey: str, leaseId: str, leaseHolder: str })
  .strict();
export type Lease = z.infer<typeof leaseSchema>;
export const releaseReceiptSchema = z
  .object({
    id: idSchema,
    operationId: idSchema,
    launchId: idSchema,
    path: hostPathSchema,
    releasedAt: timestampSchema,
    lease: z.object({ leaseId: str, leaseHolder: str }).strict().optional(),
  })
  .strict();
export type ReleaseReceipt = z.infer<typeof releaseReceiptSchema>;
export const allocatedWorkerSchema = z
  .union([
    z
      .object({
        launchId: idSchema,
        kind: z.enum(["implementation", "scout"]),
        directory: hostPathSchema,
        reportSourcePath: str.optional(),
        scope: z.literal("project"),
        project: hostPathSchema,
        // Legacy local adoption cannot reconstruct the original launch SHA; new allocation still requires it.
        sourceHead: shaSchema.optional(),
        lease: leaseSchema,
      })
      .strict(),
    z
      .object({
        launchId: idSchema,
        kind: z.literal("scout"),
        directory: hostPathSchema,
        reportSourcePath: str,
        scope: z.literal("independent"),
      })
      .strict(),
  ])
  .refine((v) => v.kind !== "scout" || !!v.reportSourcePath, "Scout requires reportSourcePath");
export type AllocatedWorker = z.infer<typeof allocatedWorkerSchema>;
export const operationViewSchema = z
  .object({
    operationId: idSchema,
    requestHash: digestSchema,
    state: z.enum(["prepared", "running", "confirmed", "refused", "uncertain"]),
    checkpoint: z
      .object({
        resource: allocatedWorkerSchema.optional(),
        deliveryBase: shaSchema.optional(),
        rebasedHead: shaSchema.optional(),
        targetHead: shaSchema.optional(),
        spaceClosed: z.boolean().optional(),
        directoryReleased: z.boolean().optional(),
      })
      .strict()
      .optional(),
    result: z.unknown().optional(),
    error: hostErrorSchema.optional(),
  })
  .strict();
export type OperationView = z.infer<typeof operationViewSchema>;
export const snapshotSchema = z
  .object({
    project: hostPathSchema,
    head: shaSchema,
    branch: str.optional(),
    excludedChanges: z.string(),
    starts: z.record(z.string(), shaSchema),
    originWarnings: map,
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const toolCheckSchema = z
  .object({ name: str, available: z.boolean(), version: str.optional(), capabilities: strings })
  .strict();
export type ToolCheck = z.infer<typeof toolCheckSchema>;
export const helloResultSchema = z
  .object({
    helperVersion: str,
    buildId: str,
    hostId: idSchema,
    os: z.enum(["linux", "darwin", "win32"]),
    arch: str,
    capabilities: strings,
    maxFrameBytes: count.refine((v) => v > 0),
    reportChunkBytes: count.refine((v) => v > 0 && v <= 65536),
  })
  .strict();
export type HelloResult = z.infer<typeof helloResultSchema>;
export const preflightResultSchema = z
  .object({
    host: helloResultSchema,
    context: configurationContextSchema,
    runtimeRoot: hostPathSchema,
    neutralRoot: hostPathSchema,
    overlaySha256: digestSchema,
    tools: z.array(toolCheckSchema),
  })
  .strict();
export type PreflightResult = z.infer<typeof preflightResultSchema>;
export const workerInspectionSchema = z
  .object({
    launchId: idSchema,
    directory: hostPathSchema,
    leaseValid: z.boolean(),
    dirty: z.string().optional(),
    head: shaSchema.optional(),
    projectHead: shaSchema.optional(),
    branch: str.optional(),
    workerIsDelivered: z.boolean().optional(),
    deliveryReceipt: deliveryReceiptSchema.optional(),
  })
  .strict();
export type WorkerInspection = z.infer<typeof workerInspectionSchema>;
const catalogModel = z
  .object({
    selector: str,
    provider: str,
    id: str,
    name: str.optional(),
    contextWindow: count.optional(),
    maxTokens: count.optional(),
    thinking: strings,
    input: strings,
    cost: z
      .object({ input: z.number().nonnegative(), output: z.number().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
const usageWindow = z
  .object({
    window: str,
    status: str.optional(),
    remaining_percent: z.number().optional(),
    remaining: z.number().optional(),
    limit: z.number().optional(),
    unit: str.optional(),
    window_elapsed_percent: z.number().optional(),
    resets_at: timestampSchema.optional(),
    resets_in: str.optional(),
  })
  .strict();
const usageResult = z
  .object({
    context: configurationContextSchema,
    generated_at: timestampSchema,
    providers: z.array(
      z
        .object({
          provider: str,
          roles: strings,
          accounts: z.array(
            z
              .object({
                account: str,
                plan: str.optional(),
                limit_reached: z.literal(true).optional(),
                windows: z.array(usageWindow),
              })
              .strict(),
          ),
          capacity: z.array(
            z
              .object({
                window: str,
                accounts: count,
                remaining_accounts: z
                  .number()
                  .nonnegative()
                  .refine(Number.isFinite, "Expected finite remaining account capacity"),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    roles: map,
    accounts_without_usage: strings.optional(),
    disabled_credentials: z.array(z.unknown()).optional(),
  })
  .strict();
const launch = { launchId: idSchema };
const task = z
  .object({
    name: str,
    kind: z.enum(["implementation", "scout"]),
    startFrom: str.optional(),
    pushTo: str.optional(),
  })
  .strict();
export const hostArgsSchemas = {
  hello: z.object({ supportedVersions: z.array(z.literal(1)).min(1).max(1) }).strict(),
  preflight: z.union([
    z
      .object({
        scope: z.literal("project"),
        projectPath: str,
        context: configurationContextSchema.optional(),
        requiredOverlaySha256: digestSchema,
        requiredTools: strings.optional(),
      })
      .strict(),
    z
      .object({
        scope: z.literal("independent"),
        context: configurationContextSchema.optional(),
        requiredOverlaySha256: digestSchema,
        requiredTools: strings.optional(),
      })
      .strict(),
  ]),
  "path.validate": z
    .object({ path: str, kind: z.enum(["git_root", "projects_root", "forbidden_root"]) })
    .strict(),
  "project.create": z.object({ path: str, registrationId: idSchema }).strict(),
  "project.snapshot": z.object({ projectPath: str, tasks: z.array(task).min(1) }).strict(),
  "worker.allocate": z.union([
    z
      .object({
        ...launch,
        kind: z.enum(["implementation", "scout"]),
        scope: z.literal("project"),
        projectPath: str,
        sourceHead: shaSchema,
        forbiddenRoots: z.array(hostPathSchema),
      })
      .strict(),
    z
      .object({
        ...launch,
        kind: z.literal("scout"),
        scope: z.literal("independent"),
        forbiddenRoots: z.array(hostPathSchema),
      })
      .strict(),
  ]),
  "worker.lookup": z.object(launch).strict(),
  "worker.inspect": z.object(launch).strict(),
  "worker.bind-agent": z.object({ ...launch, binding: agentBindingSchema }).strict(),
  "omp.context": z.object({ requiredOverlaySha256: digestSchema }).strict(),
  "omp.models": z.object({ context: configurationContextSchema }).strict(),
  "omp.usage": z.object({ context: configurationContextSchema, now: count }).strict(),
  "session.last-response": z.object({ ...launch, sessionPath: str }).strict(),
  "report.read": z.object(launch).strict(),
  "report.ack": z.object({ ...launch, receipt: reportReceiptSchema }).strict(),
  "delivery.land": z
    .object({
      ...launch,
      expectedBranch: str,
      deliveryBase: shaSchema,
      expectedWorkerHead: shaSchema,
    })
    .strict(),
  "delivery.push": z.object({ ...launch, pushTo: str, expectedWorkerHead: shaSchema }).strict(),
  "delivery.lookup": z.object({ ...launch, operationId: idSchema }).strict(),
  "worker.release": z
    .object({
      ...launch,
      leaseId: str.optional(),
      leaseHolder: str.optional(),
      proof: z.enum(["settled", "closed", "discard"]),
      receiptId: idSchema.optional(),
      herdrClosed: z.literal(true),
    })
    .strict(),
  "operation.get": z.object({ operationId: idSchema }).strict(),
  "worker.forget": z.object({ ...launch, cleanupReceiptId: idSchema }).strict(),
} as const;
export const hostResultSchemas = {
  hello: helloResultSchema,
  preflight: preflightResultSchema,
  "path.validate": z.object({ path: hostPathSchema, gitRoot: hostPathSchema.optional() }).strict(),
  "project.create": z
    .object({ registrationId: idSchema, project: hostPathSchema, head: shaSchema })
    .strict(),
  "project.snapshot": snapshotSchema,
  "worker.allocate": allocatedWorkerSchema,
  "worker.lookup": z
    .object({
      ...launch,
      resource: allocatedWorkerSchema.optional(),
      binding: agentBindingSchema.optional(),
      operations: z.array(operationViewSchema),
    })
    .strict(),
  "worker.inspect": workerInspectionSchema,
  "worker.bind-agent": z.object({ ...launch, binding: agentBindingSchema }).strict(),
  "omp.context": z.object({ context: configurationContextSchema }).strict(),
  "omp.models": z
    .object({
      context: configurationContextSchema,
      catalog: z.array(catalogModel),
      roles: map,
      defaultChoice: z.object({ model: str, thinking: str.optional() }).strict(),
    })
    .strict(),
  "omp.usage": usageResult,
  "session.last-response": z.union([
    z.object({ text: z.string() }).strict(),
    z.object({ unavailableReason: str }).strict(),
  ]),
  "report.ack": z.object({ receiptId: idSchema, sha256: digestSchema, byteCount: count }).strict(),
  "delivery.land": deliveryReceiptSchema,
  "delivery.push": deliveryReceiptSchema,
  "delivery.lookup": z
    .object({ operation: operationViewSchema, receipt: deliveryReceiptSchema.optional() })
    .strict(),
  "worker.release": releaseReceiptSchema,
  "operation.get": operationViewSchema,
  "worker.forget": z.object({ ...launch, forgotten: z.literal(true) }).strict(),
} as const;
export type HostOp = keyof typeof hostArgsSchemas;
export type ResultOp = keyof typeof hostResultSchemas;
export type HostArgs = { [Op in HostOp]: z.infer<(typeof hostArgsSchemas)[Op]> };
export type HostResults = { [Op in ResultOp]: z.infer<(typeof hostResultSchemas)[Op]> };
export type HostResult<Op extends ResultOp = ResultOp> = HostResults[Op];
export type MutationOp =
  | "project.create"
  | "worker.allocate"
  | "worker.bind-agent"
  | "report.ack"
  | "delivery.land"
  | "delivery.push"
  | "worker.release"
  | "worker.forget";
export type HostRequest<Op extends HostOp = HostOp> = {
  [K in Op]: {
    protocol: typeof PROTOCOL;
    version: 1;
    requestId: Id;
    controllerId: Id;
    op: K;
    args: HostArgs[K];
  } & (K extends "hello" ? { expectedHostId?: Id } : { expectedHostId: Id }) &
    (K extends MutationOp ? { operationId: Id } : { operationId?: Id });
}[Op];
export type HostReply<Op extends ResultOp = ResultOp> = {
  protocol: typeof PROTOCOL;
  version: 1;
  requestId: string;
  hostId: string;
} & ({ ok: true; result: HostResult<Op> } | { ok: false; error: HostError });
export const mutationOps: Partial<Record<HostOp, true>> = {
  "project.create": true,
  "worker.allocate": true,
  "worker.bind-agent": true,
  "report.ack": true,
  "delivery.land": true,
  "delivery.push": true,
  "worker.release": true,
  "worker.forget": true,
};
const envelope = { protocol: z.literal(PROTOCOL), version: z.literal(1), requestId: idSchema };
const requestEnvelope = z
  .object({
    ...envelope,
    controllerId: idSchema,
    expectedHostId: idSchema.optional(),
    operationId: idSchema.optional(),
    op: z.enum(Object.keys(hostArgsSchemas) as [HostOp, ...HostOp[]]),
    args: z.unknown(),
  })
  .strict();
export function validateHostRequest(value: unknown): HostRequest {
  const request = requestEnvelope.parse(value);
  if (request.op !== "hello" && !request.expectedHostId)
    throw new Error("expectedHostId required after discovery");
  if (mutationOps[request.op] && !request.operationId)
    throw new Error("Mutation requires operationId");
  return { ...request, args: hostArgsSchemas[request.op].parse(request.args) } as HostRequest;
}
export function validateOperationView(value: unknown, resultOp?: ResultOp): OperationView {
  const view = operationViewSchema.parse(value);
  if (view.result !== undefined) {
    if (!resultOp || !mutationOps[resultOp])
      throw new Error("Recorded result requires its original mutation operation");
    view.result = validateHostResult(resultOp, view.result);
  }
  return view;
}
export function validateHostResult<Op extends ResultOp>(
  op: Op,
  value: unknown,
  operationResults: Readonly<Record<string, ResultOp>> = {},
): HostResult<Op> {
  const result = hostResultSchemas[op].parse(value);
  if (op === "worker.allocate") {
    const resource = result as AllocatedWorker;
    if (resource.scope === "project" && !resource.sourceHead)
      throw new Error("New project allocation requires the captured source SHA");
  }
  if (op === "delivery.land" && (result as DeliveryReceipt).kind === "pushed")
    throw new Error("Land cannot return push receipt");
  if (op === "delivery.push" && (result as DeliveryReceipt).kind !== "pushed")
    throw new Error("Push requires pushed receipt");
  const views =
    op === "operation.get"
      ? [result as OperationView]
      : op === "delivery.lookup"
        ? [(result as HostResults["delivery.lookup"]).operation]
        : op === "worker.lookup"
          ? (result as HostResults["worker.lookup"]).operations
          : [];
  for (const view of views) validateOperationView(view, operationResults[view.operationId]);
  return result as HostResult<Op>;
}
export function validateHostReply<Op extends ResultOp>(
  request: HostRequest<Op>,
  value: unknown,
  operationResults: Readonly<Record<string, ResultOp>> = {},
): HostReply<Op> {
  const reply = z
    .union([
      z
        .object({ ...envelope, hostId: idSchema, ok: z.literal(true), result: z.unknown() })
        .strict(),
      z
        .object({ ...envelope, hostId: idSchema, ok: z.literal(false), error: hostErrorSchema })
        .strict(),
    ])
    .parse(value);
  if (
    reply.requestId !== request.requestId ||
    (request.expectedHostId && reply.hostId !== request.expectedHostId)
  )
    throw new Error("Reply identity mismatch");
  if (!reply.ok) return reply;
  const result = validateHostResult(request.op, reply.result, operationResults);
  if (
    request.op === "path.validate" &&
    (request as HostRequest<"path.validate">).args.kind === "git_root" &&
    !(result as HostResults["path.validate"]).gitRoot
  )
    throw new Error("Git root confirmation required");
  return { ...reply, result };
}
const frameBase = { ...envelope, hostId: idSchema };
export const reportFrameSchema = z.union([
  z
    .object({
      ...frameBase,
      type: z.literal("begin"),
      launchId: idSchema,
      filename: str.refine((v) => !/[\\/]/.test(v)),
      byteCount: count,
      fileIdentity: str,
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("chunk"),
      offset: count,
      bytesBase64: str.refine(
        (v) =>
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v) &&
          Buffer.from(v, "base64").toString("base64") === v &&
          Buffer.from(v, "base64").length <= 65536,
        "Invalid bounded base64 chunk",
      ),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("end"),
      byteCount: count,
      sha256: digestSchema,
      fileIdentity: str,
    })
    .strict(),
]);
export type ReportFrame = z.infer<typeof reportFrameSchema>;
export function validateReportFrame(value: unknown): ReportFrame {
  return reportFrameSchema.parse(value);
}
export const invocationSchema = z
  .object({ executable: str, prefixArgs: z.array(z.string()) })
  .strict();
export type Invocation = z.infer<typeof invocationSchema>;
export const helperConfigurationSchema = z
  .object({
    version: z.literal(1),
    hostId: idSchema.refine(
      (value) => value !== UNCONFIGURED_HOST_ID,
      "Unconfigured identity is reserved",
    ),
    overlayPath: str,
    runtimeRoot: str,
    neutralRoot: str,
    queryCwd: str,
    approvedProjectRoots: strings,
    ompProfile: str.optional(),
    executables: z
      .object({ git: invocationSchema, treehouse: invocationSchema, omp: invocationSchema })
      .strict(),
  })
  .strict();
export type HelperConfiguration = z.infer<typeof helperConfigurationSchema>;

/** Incremental validation keeps large reports bounded and prevents publishing truncated exports. */
export class ReportStreamValidator {
  readonly #request: HostRequest<"report.read">;
  readonly #hash = createHash("sha256");
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #begin?: Extract<ReportFrame, { type: "begin" }>;
  #offset = 0;
  #content = false;
  #ended = false;
  constructor(request: HostRequest<"report.read">) {
    this.#request = request;
  }
  accept(value: unknown): ReportFrame {
    const frame = validateReportFrame(value);
    if (
      this.#ended ||
      frame.requestId !== this.#request.requestId ||
      frame.hostId !== this.#request.expectedHostId
    )
      throw new Error("Unexpected report frame or identity");
    if (frame.type === "begin") {
      if (this.#begin || frame.launchId !== this.#request.args.launchId || !frame.byteCount)
        throw new Error("Invalid report begin");
      this.#begin = frame;
    } else {
      if (!this.#begin) throw new Error("Report begin required");
      if (frame.type === "chunk") {
        const bytes = Buffer.from(frame.bytesBase64, "base64");
        if (frame.offset !== this.#offset || this.#offset + bytes.length > this.#begin.byteCount)
          throw new Error("Invalid report offset or size");
        const text = this.#decoder.decode(bytes, { stream: true });
        this.#content ||= /\S/u.test(text);
        this.#hash.update(bytes);
        this.#offset += bytes.length;
      } else {
        const remaining = this.#decoder.decode();
        this.#content ||= /\S/u.test(remaining);
        if (
          !this.#content ||
          frame.byteCount !== this.#offset ||
          frame.byteCount !== this.#begin.byteCount ||
          frame.fileIdentity !== this.#begin.fileIdentity ||
          frame.sha256 !== this.#hash.digest("hex")
        )
          throw new Error("Invalid or changed report export");
        this.#ended = true;
      }
    }
    return frame;
  }
  finish(): void {
    if (!this.#ended) throw new Error("Report stream ended without validated end frame");
  }
}
