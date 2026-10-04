import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHostReply } from "../.omp/runtime/helper-protocol";

const root = fileURLToPath(new URL("../", import.meta.url));
const shim = fileURLToPath(new URL("./helper-agent-shim.ts", import.meta.url));
export const nativeTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

export async function verifyHelper(executable: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "helper-build-"));
  try {
    const hostId = randomUUID();
    const config = join(scratch, "helper.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        hostId,
        runtimeRoot: join(scratch, "runtime"),
        neutralRoot: join(scratch, "neutral"),
        overlayPath: join(scratch, "overlay"),
        queryCwd: scratch,
        approvedProjectRoots: [join(scratch, "projects")],
        executables: Object.fromEntries(
          ["git", "treehouse", "omp"].map((name) => [name, { executable: name, prefixArgs: [] }]),
        ),
      }),
    );
    const request = {
      protocol: "omp-orchestrator-helper",
      version: 1,
      requestId: randomUUID(),
      controllerId: randomUUID(),
      op: "hello",
      args: { supportedVersions: [1] },
    } as const;
    const child = Bun.spawn([executable, "--stdio-v1"], {
      env: { ...process.env, OMP_ORCHESTRATOR_HELPER_CONFIG: config },
      stdin: new Blob([`${JSON.stringify(request)}\n`]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) throw new Error(`Helper hello failed (${exit}): ${stderr}`);
      const reply = validateHostReply(request, JSON.parse(stdout));
      if (
        !reply.ok ||
        reply.requestId !== request.requestId ||
        reply.hostId !== hostId ||
        reply.result.hostId !== hostId ||
        reply.result.os !== process.platform ||
        reply.result.arch !== process.arch
      )
        throw new Error(
          "Compiled helper did not answer the native stdio hello with the expected identity.",
        );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function buildHelper(target = nativeTarget, outfile?: string): Promise<string> {
  if (!/^bun-(linux|darwin|windows)-(x64|arm64)(-baseline|-modern)?$/.test(target))
    throw new Error(`Unsupported helper target: ${target}`);
  const output = resolve(
    outfile ??
      join(
        root,
        "node_modules/.bin",
        `omp-orchestrator-helper${target.startsWith("bun-windows-") ? ".exe" : ""}`,
      ),
  );
  await mkdir(dirname(output), { recursive: true });
  // The extension shares OMP's zod; the standalone binary must not bundle the agent package.
  const result = await Bun.build({
    entrypoints: [join(root, ".omp/runtime/helper-entry.ts")],
    compile: { outfile: output, target: target as Bun.Build.CompileTarget },
    plugins: [
      {
        name: "helper-agent-shim",
        setup(build) {
          build.onResolve({ filter: /^@oh-my-pi\/pi-coding-agent$/ }, () => ({ path: shim }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Helper compilation failed");
  if (
    target === nativeTarget ||
    target === `${nativeTarget}-baseline` ||
    target === `${nativeTarget}-modern`
  ) {
    try {
      await verifyHelper(output);
    } catch (error) {
      await rm(output, { force: true });
      throw error;
    }
    console.log(`Built ${output}; native stdio hello verified.`);
  } else
    console.log(`Built ${output} for ${target}; run stdio hello on that host before installing.`);
  return output;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--target"))
    throw new Error(
      "Usage: bun run helper:build [--target bun-<linux|darwin|windows>-<x64|arm64>]",
    );
  await buildHelper(args[1]);
}
