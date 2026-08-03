import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, FakeExec, fixtureRoot, register, runtime } from "./test-helpers";

afterEach(cleanup);
describe("project registry", () => {
	test("lists empty and writes sorted canonical registrations atomically", async () => {
		const { root, project } = await fixtureRoot();
		const second = join(root, "second");
		await mkdir(second);
		const fake = new FakeExec(project);
		const instance = runtime(root, fake, []);
		expect((await instance.runProjects({ op: "list" })).details).toEqual([]);
		await register(instance, second, "zeta");
		await register(instance, project, "alpha");
		await register(instance, project, "alpha");
		expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(`${JSON.stringify({ alpha: project, zeta: second }, null, 2)}\n`);
		expect((await instance.runProjects({ op: "add", name: "other", path: project })).isError).toBe(true);
		await instance.runProjects({ op: "remove", name: "zeta" });
		expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(`${JSON.stringify({ alpha: project }, null, 2)}\n`);
		expect(fake.calls.some(call => call.command === "git" && call.args[0] === "reset")).toBe(false);
	});

	test("malformed registries fail without rewriting", async () => {
		const { root, project } = await fixtureRoot();
		await mkdir(join(root, ".omp"));
		await writeFile(join(root, ".omp", "projects.json"), "{bad");
		const instance = runtime(root, new FakeExec(project), []);
		expect((await instance.runProjects({ op: "list" })).isError).toBe(true);
		expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe("{bad");
	});
});
