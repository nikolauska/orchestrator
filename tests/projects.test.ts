import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

	test("creates and registers new projects under a configured root", async () => {
		const { root, project } = await fixtureRoot();
		const projectsRoot = join(root, "projects");
		await mkdir(projectsRoot);
		const fake = new FakeExec(project);
		const instance = runtime(root, fake, []);
		expect((await instance.runProjects({ op: "create", name: "api" })).isError).toBe(true);
		expect((await instance.runProjects({ op: "set-root", path: projectsRoot })).details).toEqual({ path: projectsRoot });
		await instance.runProjects({ op: "create", name: "api" });
		expect((await instance.runProjects({ op: "list" })).details).toEqual([{ name: "api", path: join(projectsRoot, "api") }]);
		expect(fake.calls).toContainEqual({ command: "git", args: ["init"], cwd: join(projectsRoot, "api") });
		expect((await instance.runProjects({ op: "create", name: "web", path: join(projectsRoot, "custom-web") })).isError).toBeUndefined();
		expect(await readFile(join(root, ".omp", "projects-root"), "utf8")).toBe(`${projectsRoot}\n`);
	});

	test("refuses existing creation destinations", async () => {
		const { root, project } = await fixtureRoot();
		const destination = join(root, "existing");
		await mkdir(destination);
		const instance = runtime(root, new FakeExec(project), []);
		expect((await instance.runProjects({ op: "create", name: "existing", path: destination })).isError).toBe(true);
		expect((await instance.runProjects({ op: "list" })).details).toEqual([]);
	});
	test("keeps a new folder when Git initialization fails", async () => {
		const { root, project } = await fixtureRoot();
		const destination = join(root, "failed");
		const fake = new FakeExec(project);
		fake.gitInitFails = true;
		const instance = runtime(root, fake, []);
		expect((await instance.runProjects({ op: "create", name: "failed", path: destination })).isError).toBe(true);
		expect((await stat(destination)).isDirectory()).toBe(true);
		expect((await instance.runProjects({ op: "list" })).details).toEqual([]);
	});
});
