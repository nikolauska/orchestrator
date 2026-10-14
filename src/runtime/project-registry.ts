import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "@oh-my-pi/omptype/zod";
import { idSchema, nativeStringSchema } from "./execution";

const str = nativeStringSchema;
export const registryBindingSchema = z
  .object({
    sshTarget: str.refine((value) => !value.startsWith("-")),
    session: str,
    hostId: idSchema,
  })
  .strict();
export type RegistryBinding = z.infer<typeof registryBindingSchema>;
export type ProjectEntry =
  | { machine: "local"; path: string; pathKey?: string; binding?: never }
  | { machine: string; path: string; pathKey: string; binding: RegistryBinding };
export type ProjectRoot = { path: string; pathKey?: string; binding?: RegistryBinding };
export type ProjectRegistry = {
  version: 2;
  projects: Record<string, ProjectEntry>;
  roots: Record<string, ProjectRoot>;
};
export type RegistryRead = {
  registry: ProjectRegistry;
  issues: { name: string; kind: "project" | "root"; message: string }[];
};
const localEntry = z
  .object({ machine: z.literal("local"), path: str, pathKey: str.optional() })
  .strict();
const remoteEntry = z
  .object({
    machine: str.refine((value) => value !== "local"),
    path: str,
    pathKey: str,
    binding: registryBindingSchema,
  })
  .strict();
const rootEntry = z
  .object({ path: str, pathKey: str.optional(), binding: registryBindingSchema.optional() })
  .strict();
// Keep old reserved registrations readable so removal can repair them without probing a host.
const nameSchema = z.union([
  z.literal("_independent"),
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
]);
const envelopeSchema = z
  .object({
    version: z.literal(2),
    projects: z.record(nameSchema, z.union([localEntry, remoteEntry])),
    roots: z
      .record(str, rootEntry)
      .optional()
      .default(() => ({})),
  })
  .strict();

/** No filesystem canonicalization during migration: an offline disk must not erase registrations. */
export function normalizeProjectRegistry(value: unknown, legacyRoot?: string): RegistryRead {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed .omp/projects.json");
  const candidate = value as Record<string, unknown>;
  const envelope =
    Number.isInteger(candidate.version) &&
    !!candidate.projects &&
    typeof candidate.projects === "object" &&
    !Array.isArray(candidate.projects);
  let registry: ProjectRegistry;
  if (envelope) {
    if (candidate.version !== 2)
      throw new Error(`Unsupported projects registry version: ${candidate.version}`);
    registry = envelopeSchema.parse(value) as ProjectRegistry;
  } else {
    const legacy = z.record(nameSchema, z.string()).parse(value);
    registry = {
      version: 2,
      projects: Object.fromEntries(
        Object.entries(legacy).map(([name, path]) => [name, { machine: "local", path }]),
      ),
      roots: {},
    };
  }
  for (const [machine, root] of Object.entries(registry.roots)) {
    if (machine === "local" ? !!root.binding : !root.binding || !root.pathKey)
      throw new Error("Invalid projects root binding or pathKey");
  }
  if (!registry.roots.local && legacyRoot?.trim())
    registry.roots.local = { path: legacyRoot.trim() };
  const issues: RegistryRead["issues"] = [];
  for (const [name, entry] of Object.entries(registry.projects))
    if (!entry.pathKey)
      issues.push({
        kind: "project",
        name,
        message: "Pending local validation; path identity is unknown",
      });
  for (const [name, entry] of Object.entries(registry.roots))
    if (!entry.pathKey)
      issues.push({
        kind: "root",
        name,
        message: "Pending local validation; path identity is unknown",
      });
  return { registry, issues };
}
export async function readProjectRegistry(
  controllerRoot: string,
  signal?: AbortSignal,
): Promise<RegistryRead> {
  signal?.throwIfAborted();
  const optionalRead = async (filename: string): Promise<string | undefined> => {
    try {
      return await readFile(join(controllerRoot, ".omp", filename), { encoding: "utf8", signal });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  };
  const raw = await optionalRead("projects.json");
  const root = await optionalRead("projects-root");
  signal?.throwIfAborted();
  return normalizeProjectRegistry(raw === undefined ? {} : JSON.parse(raw), root);
}
