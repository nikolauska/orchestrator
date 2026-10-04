import type { CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { mkdir, open, rename, rm } from "node:fs/promises";
import {
  callMachine,
  machineError,
  resolveMachine,
  validateBinding,
  type ResolvedMachine,
} from "../../runtime/machines";
import { canonicalPath } from "../../runtime/host-paths";
import {
  normalizeProjectRegistry,
  readProjectRegistry,
  type ProjectEntry,
  type ProjectRegistry,
  type RegistryRead,
} from "../../runtime/project-registry";
import {
  errorMessage,
  NAME,
  projectNameSchema,
  text,
  type ToolAPI,
  type ToolFactory,
} from "../../runtime/shared";
import { requireOwnership, stateFor } from "./workers";

export async function readProjects(root: string, signal?: AbortSignal): Promise<ProjectRegistry> {
  return (await readProjectRegistry(root, signal)).registry;
}

export function validateName(name: string, kind: string): void {
  if (typeof name !== "string" || !NAME.test(name))
    throw new Error(`Invalid ${kind} name: ${name}`);
}

// Supervisor ownership excludes other processes; this queue excludes concurrent calls without a crash-stale disk lock.
const writers = new Map<string, Promise<void>>();
async function mutateRegistry<T>(
  pi: ToolAPI,
  signal: AbortSignal | undefined,
  work: (read: RegistryRead) => Promise<T>,
): Promise<T> {
  const state = stateFor(pi);
  requireOwnership(state);
  const root = resolve(pi.cwd);
  const previous = writers.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  writers.set(root, current);
  await previous;
  try {
    signal?.throwIfAborted();
    requireOwnership(state);
    return await work(await readProjectRegistry(root, signal));
  } finally {
    release();
    if (writers.get(root) === current) writers.delete(root);
  }
}

async function writeProjects(
  pi: ToolAPI,
  registry: ProjectRegistry,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  requireOwnership(stateFor(pi));
  // Pending legacy identities stay absent; requiring every disk online would lose migrations.
  const normalized = normalizeProjectRegistry(registry).registry;
  const sort = <T>(entries: Record<string, T>) =>
    Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  const sorted = { version: 2, projects: sort(normalized.projects), roots: sort(normalized.roots) };
  const destination = join(pi.cwd, ".omp", "projects.json");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(sorted, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    requireOwnership(stateFor(pi));
    await rename(temporary, destination);
    await rm(join(pi.cwd, ".omp", "projects-root"), { force: true });
  } finally {
    await rm(temporary, { force: true });
  }
}

function projectResult(registry: ProjectRegistry, machine = "local"): CustomToolResult {
  const items = Object.entries(registry.projects)
    .filter(([, entry]) => entry.machine === machine)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      name,
      machine: entry.machine,
      path: entry.path,
      ...(entry.pathKey
        ? { path_key: entry.pathKey }
        : { issues: ["Pending local validation; path identity is unknown"] }),
      ...(entry.binding ? { binding: entry.binding } : {}),
    }));
  const root = Object.hasOwn(registry.roots, machine) ? registry.roots[machine] : undefined;
  const issue =
    root && !root.pathKey
      ? `\nProjects root ${root.path}: pending local validation; path identity is unknown.`
      : "";
  return text(
    `Registered projects on ${machine}:\n${JSON.stringify(items, null, 2)}${issue}`,
    items,
  );
}

function projectEntry(
  resolved: ResolvedMachine,
  path: { path: string; pathKey: string },
): ProjectEntry {
  if (!resolved.binding) return { machine: "local", ...path };
  const { sshTarget, session, hostId } = resolved.binding;
  return { machine: resolved.machine.machineId, ...path, binding: { sshTarget, session, hostId } };
}

async function assertUnique(
  pi: ToolAPI,
  registry: ProjectRegistry,
  candidate: ProjectEntry,
  hostId: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  let localHostId = candidate.machine === "local" ? hostId : undefined;
  for (const [otherName, other] of Object.entries(registry.projects)) {
    if (otherName === name) continue;
    if (other.machine === "local" && !localHostId)
      localHostId = (
        await resolveMachine(pi, "local", { controllerId: stateFor(pi).store.controllerId, signal })
      ).host.hostId;
    if ((other.binding?.hostId ?? localHostId) !== hostId) continue;
    let key = other.pathKey;
    if (!key && other.machine === "local") {
      try {
        key = (await canonicalPath(other.path)).pathKey;
      } catch {
        continue;
      }
    }
    if (key === candidate.pathKey)
      throw new Error(`Project root already registered as ${otherName} on the same host.`);
  }
}

const projectsTool: ToolFactory = (pi) => {
  const z = pi.zod;
  const machine = z.string().min(1).optional();
  const runnableName = projectNameSchema(z).refine(
    (name) => name !== "_independent",
    "_independent is reserved for independent scout reports",
  );
  const parameters = z.union([
    z.object({ op: z.literal("list"), machine }).strict(),
    z
      .object({
        op: z.literal("add"),
        name: runnableName,
        path: z.string().min(1),
        machine,
      })
      .strict(),
    z
      .object({
        op: z.literal("create"),
        name: runnableName,
        path: z.string().optional(),
        machine,
      })
      .strict(),
    z.object({ op: z.literal("remove"), name: projectNameSchema(z) }).strict(),
    z.object({ op: z.literal("set-root"), path: z.string().min(1), machine }).strict(),
  ]);
  return {
    name: "projects",
    label: "Projects",
    loadMode: "essential",
    approval: "write",
    description:
      "Register and create Git projects on one machine. Omitted machine means local; remote values are saved Herdr IDs or unique labels. List filters by saved ID without connecting. Removal unregisters only; repositories, workers, and reports remain.",
    parameters,
    execute: async (_id, input, signal) => {
      try {
        const params = parameters.parse(input);
        if (params.op === "list")
          return projectResult(await readProjects(pi.cwd, signal), params.machine);
        return await mutateRegistry(pi, signal, async ({ registry }) => {
          if (params.op === "remove") {
            const entry = registry.projects[params.name];
            if (!entry || !Object.hasOwn(registry.projects, params.name))
              throw new Error(`Unknown registered project: ${params.name}`);
            delete registry.projects[params.name];
            await writeProjects(pi, registry, signal);
            return projectResult(registry, entry.machine);
          }
          const options = { controllerId: stateFor(pi).store.controllerId, signal };
          const resolved = await resolveMachine(pi, params.machine, options);
          const machineId = resolved.machine.machineId;
          if (params.op === "set-root") {
            const validated = await callMachine(
              pi,
              resolved,
              "path.validate",
              { path: params.path, kind: "projects_root" },
              options,
            );
            const entry = projectEntry(resolved, validated.path);
            registry.roots[machineId] = {
              path: entry.path,
              pathKey: entry.pathKey,
              ...(entry.binding ? { binding: entry.binding } : {}),
            };
            await writeProjects(pi, registry, signal);
            const details = { machine: machineId, path: entry.path, path_key: entry.pathKey };
            return text(`Projects root on ${machineId}: ${entry.path}`, details);
          }
          const existing = Object.hasOwn(registry.projects, params.name)
            ? registry.projects[params.name]
            : undefined;
          if (existing && (params.op === "create" || existing.machine !== machineId))
            throw new Error(`Project name already registered: ${params.name}`);
          if (existing?.binding)
            validateBinding(
              resolved.machine,
              { machineId: existing.machine, ...existing.binding },
              resolved.host.hostId,
            );
          let path = params.path;
          if (params.op === "create" && !path) {
            const configured = Object.hasOwn(registry.roots, machineId)
              ? registry.roots[machineId]
              : undefined;
            if (!configured)
              throw new Error(
                `No projects root configured on ${machineId}; use projects.set-root first`,
              );
            if (configured.binding) {
              const bound = await resolveMachine(pi, machineId, {
                ...options,
                binding: { machineId, ...configured.binding },
              });
              if (bound.host.hostId !== resolved.host.hostId)
                throw new Error("Projects root helper identity changed during creation.");
            }
            const validated = await callMachine(
              pi,
              resolved,
              "path.validate",
              { path: configured.path, kind: "projects_root" },
              options,
            );
            if (configured.pathKey && configured.pathKey !== validated.path.pathKey)
              throw new Error(
                `Configured projects root identity changed on ${machineId}; set-root again before creating.`,
              );
            path = (resolved.host.os === "win32" ? win32 : posix).join(
              validated.path.path,
              params.name,
            );
          }
          let validated;
          if (params.op === "create") {
            const operationId = randomUUID();
            try {
              validated = (
                await callMachine(
                  pi,
                  resolved,
                  "project.create",
                  { path: path!, registrationId: randomUUID() },
                  { ...options, operationId },
                )
              ).project;
            } catch (error) {
              return text(
                `Project creation on ${machineId} failed; inspect ${path}. No partial repository was removed. ${errorMessage(error)}`,
                {
                  machine: machineId,
                  path,
                  operation_id: operationId,
                  error: machineError(error, "helper"),
                },
                true,
              );
            }
          } else {
            validated = (
              await callMachine(
                pi,
                resolved,
                "path.validate",
                { path: path!, kind: "git_root" },
                options,
              )
            ).path;
          }
          const entry = projectEntry(resolved, validated);
          if (existing && existing.path !== entry.path && existing.pathKey !== entry.pathKey)
            throw new Error(`Project name already registered: ${params.name}`);
          try {
            await assertUnique(pi, registry, entry, resolved.host.hostId, params.name, signal);
            registry.projects[params.name] = entry;
            await writeProjects(pi, registry, signal);
          } catch (error) {
            if (params.op === "create")
              return text(
                `Created repository retained at ${entry.path} on ${machineId}, but registration failed: ${errorMessage(error)}`,
                { machine: machineId, path: entry.path, error: machineError(error, "controller") },
                true,
              );
            throw error;
          }
          return projectResult(registry, machineId);
        });
      } catch (error) {
        return text(errorMessage(error), { error: machineError(error, "controller") }, true);
      }
    },
  };
};
export default projectsTool;
