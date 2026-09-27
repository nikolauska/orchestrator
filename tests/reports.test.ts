import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getReport, listReports } from "../.omp/extensions/orchestrator/reports";
import { cleanup, fixtureRoot } from "./test-helpers";

afterEach(cleanup);

async function reportsRoot(files: Record<string, string>) {
  const { root } = await fixtureRoot();
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ".omp", "reports", path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

describe("reports", () => {
  test("reads a listed report by the name the list returned", async () => {
    const root = await reportsRoot({
      "app/1-audit.md": "# Audit",
      "_independent/2-vendors.md": "# Vendors",
    });
    const listed = (await listReports(undefined, root)).details as Array<{ name: string }>;
    for (const { name } of listed) {
      const result = await getReport(name, root);
      expect(result.content[0]).toMatchObject({ type: "text" });
    }
    expect((await getReport("1-audit.md", root)).content[0]).toMatchObject({ text: "# Audit" });
    expect((await getReport("_independent/2-vendors.md", root)).content[0]).toMatchObject({
      text: "# Vendors",
    });
  });

  test("refuses ambiguous names and paths outside the reports folder", async () => {
    const root = await reportsRoot({ "a/same.md": "a", "b/same.md": "b", "../outside.md": "x" });
    await expect(getReport("same.md", root)).rejects.toThrow("ambiguous");
    expect((await getReport("b/same.md", root)).content[0]).toMatchObject({ text: "b" });
    await expect(getReport("../outside.md", root)).rejects.toThrow("listed name");
    await expect(getReport("missing.md", root)).rejects.toThrow("Unknown report");
  });
});
