import type { CustomToolAPI, CustomToolFactory, CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { errorMessage, NAME, projectNameSchema, text } from "../runtime/shared";

type Exec = CustomToolAPI["exec"];

async function runCommand(
  exec: Exec,
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const result = await exec(command, args, { cwd, signal });
  signal?.throwIfAborted();
  if (result.code !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        (result.stderr || result.stdout).trim() || `exit ${result.code}`
      }`,
    );
  return result.stdout.trim();
}

export async function readProjects(
  root: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  signal?.throwIfAborted();
  let raw: string;
  try {
    raw = await readFile(join(root, ".omp", "projects.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  signal?.throwIfAborted();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Malformed .omp/projects.json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Malformed .omp/projects.json");
  for (const [name, path] of Object.entries(parsed)) {
    if (!NAME.test(name) || typeof path !== "string")
      throw new Error("Malformed .omp/projects.json");
  }
  return parsed as Record<string, string>;
}

export function validateName(name: string, kind: string): void {
  if (typeof name !== "string" || !NAME.test(name))
    throw new Error(`Invalid ${kind} name: ${name}`);
}

async function directory(path: string, kind: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const input = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(input)) throw new Error(`${kind} must be absolute or start with ~/`);
  const canonical = await realpath(input);
  signal?.throwIfAborted();
  if (!(await stat(canonical)).isDirectory())
    throw new Error(`${kind} must be a directory: ${canonical}`);
  return canonical;
}

async function newPath(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const input = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(input)) throw new Error("Project path must be absolute or start with ~/");
  const parent = await realpath(dirname(input));
  signal?.throwIfAborted();
  return join(parent, basename(input));
}

async function readRoot(root: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let configured: string;
  try {
    configured = (await readFile(join(root, ".omp", "projects-root"), "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error("No projects root configured; use projects.set-root first");
    throw error;
  }
  if (!configured) throw new Error("Malformed .omp/projects-root");
  return directory(configured, "Configured projects root", signal);
}

async function writeRoot(root: string, path: string, signal?: AbortSignal): Promise<string> {
  const canonical = await directory(path, "Projects root", signal);
  const destination = join(root, ".omp", "projects-root");
  await mkdir(dirname(destination), { recursive: true });
  signal?.throwIfAborted();
  const temp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${canonical}\n`, { flag: "wx" });
  await rename(temp, destination);
  return canonical;
}

async function writeProjects(
  root: string,
  projects: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const path = join(root, ".omp", "projects.json");
  await mkdir(dirname(path), { recursive: true });
  signal?.throwIfAborted();
  const sorted = Object.fromEntries(
    Object.entries(projects).sort(([a], [b]) => a.localeCompare(b)),
  );
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx" });
  await rename(temp, path);
}

function projectResult(projects: Record<string, string>): CustomToolResult {
  const items = Object.entries(projects)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, path]) => ({ name, path }));
  return text(`Registered projects:\n${JSON.stringify(items, null, 2)}`, items);
}

const projectsTool: CustomToolFactory = (pi) => {
  const z = pi.zod;

  return {
    name: "projects",
    label: "Projects",
    loadMode: "essential",
    approval: "write",
    description:
      "Create, register, and manage local Git projects used by visible worker tasks. Configure a projects root before creating at the default destination. Removal unregisters only; it never deletes a repository.",
    parameters: z.union([
      z.object({ op: z.literal("list") }).strict(),
      z.object({ op: z.literal("add"), name: projectNameSchema(z), path: z.string() }).strict(),
      z
        .object({
          op: z.literal("create"),
          name: projectNameSchema(z),
          path: z.string().optional(),
        })
        .strict(),
      z.object({ op: z.literal("remove"), name: projectNameSchema(z) }).strict(),
      z.object({ op: z.literal("set-root"), path: z.string() }).strict(),
    ]),
    execute: async (_id, params, _onUpdate, _ctx, signal) => {
      const root = pi.cwd;
      const exec = pi.exec;
      try {
        signal?.throwIfAborted();
        const projects = await readProjects(root, signal);
        if (params.op === "list") return projectResult(projects);
        if (params.op === "set-root") {
          const path = await writeRoot(root, params.path, signal);
          return text(`Projects root: ${path}`, { path });
        }

        if (params.op === "remove") {
          if (!(params.name in projects))
            throw new Error(`Unknown registered project: ${params.name}`);
          delete projects[params.name];
          await writeProjects(root, projects, signal);
          return projectResult(projects);
        }
        if (params.op === "create") {
          if (projects[params.name])
            throw new Error(`Project name already registered: ${params.name}`);
          const target = params.path
            ? await newPath(params.path, signal)
            : join(await readRoot(root, signal), params.name);
          const other = Object.entries(projects).find(([, path]) => path === target);
          if (other) throw new Error(`Project path already registered as ${other[0]}`);
          await mkdir(target);
          await runCommand(exec, "git", ["init"], target, signal);
          await runCommand(
            exec,
            "git",
            ["commit", "--allow-empty", "-m", "Initial commit"],
            target,
            signal,
          );
          projects[params.name] = target;
          await writeProjects(root, projects, signal);
          return projectResult(projects);
        }

        const canonical = await directory(params.path, "Project path", signal);
        const top = await runCommand(
          exec,
          "git",
          ["rev-parse", "--show-toplevel"],
          canonical,
          signal,
        );
        const gitRoot = await realpath(top);
        if (gitRoot !== canonical) throw new Error(`Path is not an exact Git root: ${canonical}`);
        if (projects[params.name] && projects[params.name] !== canonical)
          throw new Error(`Project name already registered: ${params.name}`);
        const other = Object.entries(projects).find(
          ([name, path]) => name !== params.name && path === canonical,
        );
        if (other) throw new Error(`Project path already registered as ${other[0]}`);
        if (projects[params.name] !== canonical) {
          projects[params.name] = canonical;
          await writeProjects(root, projects, signal);
        }
        return projectResult(projects);
      } catch (error) {
        return text(errorMessage(error), undefined, true);
      }
    },
  };
};

export default projectsTool;
