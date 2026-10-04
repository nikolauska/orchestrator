import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHelper, verifyHelper } from "../scripts/build-helper";

test("compiled helper answers a real native hello and malformed usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "compiled-helper-test-"));
  try {
    const binary = await buildHelper(
      undefined,
      join(root, `helper${process.platform === "win32" ? ".exe" : ""}`),
    );
    const child = Bun.spawn([binary], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage: omp-orchestrator-helper --stdio-v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("build verification rejects a successful process with no hello reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "silent-helper-test-"));
  try {
    const source = join(root, "silent.ts");
    const binary = join(root, `silent${process.platform === "win32" ? ".exe" : ""}`);
    await writeFile(source, "process.exitCode = 0;\n");
    const result = await Bun.build({ entrypoints: [source], compile: { outfile: binary } });
    expect(result.success).toBe(true);
    await expect(verifyHelper(binary)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
