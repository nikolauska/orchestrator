// Must be OMP's own zod: schemas here are composed with store/registry schemas inside the loaded extension, and a second zod copy breaks OMP's extension loader.
import * as z from "@oh-my-pi/omptype/zod";

// Error-only identity before helper configuration is available; never a machine binding.
export const UNCONFIGURED_HOST_ID = "00000000-0000-4000-8000-000000000000";
export const idSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Expected UUID",
  );
export const shaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "Expected full Git object ID");
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected lowercase SHA-256");
export const timestampSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}, "Expected valid UTC RFC3339 timestamp");
export const nativeStringSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "NUL is forbidden");
export const hostPathSchema = z
  .object({ path: nativeStringSchema, pathKey: nativeStringSchema })
  .strict();
export type HostPath = z.infer<typeof hostPathSchema>;
export type MachineId = string;
export const machineBindingSchema = z
  .object({
    machineId: nativeStringSchema.refine((value) => value !== "local"),
    sshTarget: nativeStringSchema.refine((value) => !value.startsWith("-")),
    session: nativeStringSchema,
    hostId: idSchema,
  })
  .strict();
export type MachineBinding = z.infer<typeof machineBindingSchema>;
export const configurationContextSchema = z
  .object({
    cwd: nativeStringSchema,
    ompProfile: nativeStringSchema.optional(),
    overlayPath: nativeStringSchema,
    overlaySha256: digestSchema,
  })
  .strict();
export type ConfigurationContext = z.infer<typeof configurationContextSchema>;
const base = {
  hostId: idSchema.refine(
    (value) => value !== UNCONFIGURED_HOST_ID,
    "Unconfigured identity is not executable",
  ),
  os: z.enum(["linux", "darwin", "win32"]),
  arch: nativeStringSchema,
  pathStyle: z.enum(["posix", "win32"]),
  session: nativeStringSchema,
  workerConfig: z.object({ path: nativeStringSchema, sha256: digestSchema }).strict(),
  ompProfile: nativeStringSchema.optional(),
  runtimeRoot: hostPathSchema,
  neutralRoot: hostPathSchema,
};
export const executionTargetSchema = z
  .union([
    z.object({ ...base, kind: z.literal("local"), machineId: z.literal("local") }).strict(),
    z
      .object({
        ...base,
        kind: z.literal("ssh"),
        machineId: nativeStringSchema.refine((value) => value !== "local"),
        sshTarget: nativeStringSchema.refine((value) => !value.startsWith("-")),
      })
      .strict(),
  ])
  .superRefine((target, context) => {
    if ((target.os === "win32") !== (target.pathStyle === "win32"))
      context.addIssue({ code: "custom", message: "OS and path style disagree" });
    const absolute = (path: string) =>
      target.pathStyle === "posix"
        ? path.startsWith("/")
        : !/^[\\/]{2}[?.][\\/]/.test(path) &&
          /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(path);
    for (const path of [target.runtimeRoot.path, target.neutralRoot.path, target.workerConfig.path])
      if (!absolute(path))
        context.addIssue({
          code: "custom",
          message: "Target paths must be host-native absolute paths",
        });
  })
  .transform((target) =>
    Object.freeze({
      ...target,
      workerConfig: Object.freeze(target.workerConfig),
      runtimeRoot: Object.freeze(target.runtimeRoot),
      neutralRoot: Object.freeze(target.neutralRoot),
    }),
  );
export type ExecutionTarget = Readonly<z.infer<typeof executionTargetSchema>>;
export type TargetBase = Omit<ExecutionTarget, "kind" | "machineId" | "sshTarget">;
export const unresolvedLocalSchema = z
  .object({ kind: z.literal("unresolved_local"), machineId: z.literal("local") })
  .strict();
export const storedTargetSchema = z.union([executionTargetSchema, unresolvedLocalSchema]);
export type StoredTarget = z.infer<typeof storedTargetSchema>;
export const independentTargetSchema = z.union([
  z.object({ machineId: z.literal("local") }).strict(),
  machineBindingSchema,
]);
export type IndependentTarget = z.infer<typeof independentTargetSchema>;
export function validateExecutionTarget(value: unknown): ExecutionTarget {
  return executionTargetSchema.parse(value);
}
export function targetKey(target: ExecutionTarget): string {
  return JSON.stringify([target.hostId, target.machineId, target.session]);
}
export function agentName(controllerId: string, launchId: string): string {
  idSchema.parse(controllerId);
  idSchema.parse(launchId);
  return `o${controllerId.replaceAll("-", "").slice(0, 8).toLowerCase()}-${launchId.replaceAll("-", "").slice(0, 20).toLowerCase()}`;
}
export function leaseHolder(controllerId: string, launchId: string): string {
  idSchema.parse(controllerId);
  idSchema.parse(launchId);
  return `omp-orchestrator:${controllerId}:${launchId}`;
}
