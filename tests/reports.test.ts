import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, fixtureRoot, runtime, FakeExec } from "./test-helpers";

afterEach(cleanup);

describe("reports", () => {
	test("lists project and independent reports newest first and reads a selected report", async () => {
		const { root, project } = await fixtureRoot();
		const reports = join(root, ".omp", "reports");
		const projectReport = join(reports, "fixture", "project.md");
		const independentReport = join(reports, "_independent", "independent.md");
		await mkdir(join(reports, "fixture"), { recursive: true });
		await mkdir(join(reports, "_independent"), { recursive: true });
		await writeFile(projectReport, "# Project report\n");
		await writeFile(independentReport, "# Independent report\n");
		await utimes(projectReport, new Date("2026-01-01"), new Date("2026-01-01"));
		await utimes(independentReport, new Date("2026-01-02"), new Date("2026-01-02"));
		const instance = runtime(root, new FakeExec(project), []);

		const listed = await instance.runReports({ op: "list" });
		expect(listed.details).toEqual([
			{ namespace: "_independent", path: independentReport, modified_at: expect.any(String) },
			{ namespace: "fixture", path: projectReport, modified_at: expect.any(String) },
		]);
		expect((await instance.runReports({ op: "list", project: "fixture" })).details).toEqual([
			{ namespace: "fixture", path: projectReport, modified_at: expect.any(String) },
		]);
		expect((await instance.runReports({ op: "get", path: projectReport })).content[0].text).toBe("# Project report\n");
	});

	test("rejects paths outside the report store", async () => {
		const { root, project } = await fixtureRoot();
		const outside = join(root, "outside.md");
		await writeFile(outside, "outside");
		const result = await runtime(root, new FakeExec(project), []).runReports({ op: "get", path: outside });
		expect(result.isError).toBe(true);
	});
});
