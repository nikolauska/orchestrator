import type { CustomToolFactory, CustomToolResult } from "@oh-my-pi/pi-coding-agent";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, projectNameSchema, text } from "../runtime/shared";

export async function listReports(
  project: string | undefined,
  root: string,
  signal?: AbortSignal,
): Promise<CustomToolResult> {
  const reportsRoot = join(root, ".omp", "reports");
  let namespaces;
  try {
    signal?.throwIfAborted();
    namespaces = await readdir(reportsRoot, { withFileTypes: true });
    signal?.throwIfAborted();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return text("Reports:\n[]", []);
    throw error;
  }

  const reports = (
    await Promise.all(
      namespaces
        .filter((entry) => entry.isDirectory() && (!project || entry.name === project))
        .map(async (entry) => {
          const directory = join(reportsRoot, entry.name);
          const entries = await readdir(directory, { withFileTypes: true });
          return Promise.all(
            entries
              .filter((file) => file.isFile() && file.name.endsWith(".md"))
              .map(async (file) => {
                const path = join(directory, file.name);
                const info = await lstat(path);
                return {
                  namespace: entry.name,
                  name: file.name,
                  modified_at: info.mtime.toISOString(),
                  mtime: info.mtimeMs,
                };
              }),
          );
        }),
    )
  )
    .flat()
    .sort((left, right) => right.mtime - left.mtime || left.name.localeCompare(right.name))
    .map(({ mtime: _mtime, ...report }) => report);

  signal?.throwIfAborted();

  return text(`Reports:\n${JSON.stringify(reports, null, 2)}`, reports);
}

export async function getReport(
  name: string,
  root: string,
  signal?: AbortSignal,
): Promise<CustomToolResult> {
  signal?.throwIfAborted();
  const path = await realpath(join(root, ".omp", "reports", name));
  signal?.throwIfAborted();
  const info = await lstat(path);
  signal?.throwIfAborted();

  if (!info.isFile() || !path.endsWith(".md"))
    throw new Error("Report path must name a Markdown file");

  const content = await readFile(path, "utf8");
  signal?.throwIfAborted();
  return text(content, { path });
}

const reportsTool: CustomToolFactory = (pi) => {
  const z = pi.zod;

  return {
    name: "reports",
    label: "Reports",
    loadMode: "essential",
    approval: "read",
    description:
      "Find durable scout reports across registered projects and independent research, then read a selected report.",
    parameters: z.union([
      z
        .object({
          op: z.literal("list"),
          project: projectNameSchema(z).optional(),
        })
        .strict(),
      z.object({ op: z.literal("get"), name: z.string() }).strict(),
    ]),
    execute: async (_id, params, _onUpdate, _ctx, signal?: AbortSignal) => {
      try {
        if (params.op === "list") return await listReports(params.project, pi.cwd, signal);

        return await getReport(params.name, pi.cwd, signal);
      } catch (error) {
        return text(errorMessage(error), undefined, true);
      }
    },
  };
};

export default reportsTool;
