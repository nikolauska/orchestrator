import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VisibleWorkerRuntime, type ExecResult, type RuntimeDeps } from "../.omp/extensions/visible-workers";

type Call = { command: string; args: string[]; cwd?: string };
type Waiter = { resolve: () => void; reject: (error: Error) => void };

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixtureRoot() {
	const root = await mkdtemp(join(tmpdir(), "visible-workers-test-"));
	const project = join(root, "project");
	await mkdir(project);
	roots.push(root);
	return { root, project };
}

class FakeExec {
	readonly calls: Call[] = [];
	readonly waits = new Map<string, Waiter>();
	readonly status = new Map<string, string>();
	readonly workerHeads = new Map<string, string>();
	readonly dirtyWorkers = new Set<string>();
	projectHead = "base";
	projectBranch = "main";
	projectDirty = false;
	rebaseFails = false;
	promptStallsOnce = false;
	#reportedPromptStall = false;
	readonly project: string;

	constructor(project: string) { this.project = project; }

	exec = async (command: string, args: string[], options: { cwd?: string; signal?: AbortSignal } = {}): Promise<ExecResult> => {
		this.calls.push({ command, args: [...args], cwd: options.cwd });
		if (args[0] === "--version") return this.#ok(`${command} 1.0`);
		if (command === "treehouse" && args[0] === "get") {
			const name = args[args.indexOf("--lease-holder") + 1].split(":").at(-1)!;
			const path = join(this.project, `.treehouse-${name}`);
			await mkdir(path, { recursive: true });
			this.workerHeads.set(path, `head-${name}`);
			const hex = (this.workerHeads.size.toString(16).padStart(32, "0"));
			return this.#ok(JSON.stringify({ path, lease_id: hex, lease_holder: `omp-orchestrator:${name}` }));
		}
		if (command === "treehouse" && args[0] === "return") return this.#ok();
		if (command === "herdr" && args.includes("tab") && args.includes("create")) {
			const name = args[args.indexOf("--label") + 1];
			return this.#ok(JSON.stringify({ result: { tab: { tab_id: `tab-${name}` }, root_pane: { pane_id: `pane:${name}` } } }));
		}
		if (command === "herdr" && args.includes("tab") && args.includes("close")) return this.#ok();
		if (command === "herdr" && args.includes("pane") && args.includes("wait-output")) return this.#ok("{}");
		if (command === "herdr" && args.includes("agent") && args.includes("start")) return this.#ok("{}");
		if (command === "herdr" && args.includes("agent") && args.includes("send-keys")) {
			this.status.set(args[args.indexOf("send-keys") + 1], "working");
			return this.#ok("{}");
		}
		if (command === "herdr" && args.includes("agent") && args.includes("prompt")) {
			const pane = args[args.indexOf("prompt") + 1];
			if (this.promptStallsOnce && !this.#reportedPromptStall) {
				this.#reportedPromptStall = true;
				return this.#fail("agent_prompt_stalled");
			}
			this.status.set(pane, "working");
			return this.#ok("{}");
		}
		if (command === "herdr" && args.includes("agent") && args.includes("get")) {
			const pane = args.at(-1)!;
			return this.#ok(JSON.stringify({ result: { agent: { agent: "omp", agent_status: this.status.get(pane) ?? "working" } } }));
		}
		if (command === "herdr" && args.includes("agent") && args.includes("read")) return this.#ok(`output ${args[args.indexOf("read") + 1]}`);
		if (command === "herdr" && args.includes("agent") && args.includes("wait")) {
			const pane = args[args.indexOf("wait") + 1];
			if (args.includes("--timeout")) return this.#ok("{}");
			return await new Promise<ExecResult>((resolve, reject) => {
				const abort = () => reject(new DOMException("Aborted", "AbortError"));
				if (options.signal?.aborted) return abort();
				options.signal?.addEventListener("abort", abort, { once: true });
				this.waits.set(pane, { resolve: () => resolve(this.#ok("{}")), reject });
			});
		}
		if (command === "git") return this.#git(args, options.cwd);
		return this.#fail(`unexpected command: ${command} ${args.join(" ")}`);
	};

	settle(name: string, status = "done") {
		const pane = `pane:${name}`;
		this.status.set(pane, status);
		const waiter = this.waits.get(pane);
		if (!waiter) throw new Error(`No waiter for ${name}`);
		this.waits.delete(pane);
		waiter.resolve();
	}

	#git(args: string[], cwd?: string): ExecResult {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return this.#ok(cwd ?? this.project);
		if (args[0] === "rev-parse" && args[1] === "HEAD") return this.#ok(this.projectHead);
		if (args[0] === "check-ref-format") return args.at(-1)!.includes(" ") ? this.#fail("invalid ref") : this.#ok();
		if (args[0] === "status") return this.#ok(this.projectDirty ? "dirty" : "");
		if (args[0] === "symbolic-ref") return this.#ok(this.projectBranch);
		if (args[0] !== "-C") return this.#fail(`unexpected git args: ${args.join(" ")}`);
		const path = args[1];
		const sub = args.slice(2);
		if (sub[0] === "reset") return this.#ok();
		if (sub[0] === "status") return this.#ok(path === this.project ? (this.projectDirty ? "dirty" : "") : (this.dirtyWorkers.has(path) ? "dirty" : ""));
		if (sub[0] === "symbolic-ref") return this.#ok(this.projectBranch);
		if (sub[0] === "rev-parse") return this.#ok(path === this.project ? this.projectHead : this.workerHeads.get(path) ?? "missing");
		if (sub[0] === "merge") {
			const head = sub.at(-1)!;
			if (this.projectHead !== "base" && !head.startsWith("rebased-")) return this.#fail("not a fast-forward");
			this.projectHead = head;
			return this.#ok();
		}
		if (sub[0] === "rebase" && sub[1] === "--abort") return this.#ok();
		if (sub[0] === "rebase") {
			if (this.rebaseFails) return this.#fail("conflict");
			this.workerHeads.set(path, `rebased-${path.split("-").at(-1)}`);
			return this.#ok();
		}
		if (sub[0] === "push") return this.#ok();
		return this.#fail(`unexpected git -C: ${sub.join(" ")}`);
	}

	#ok(stdout = ""): ExecResult { return { stdout, stderr: "", code: 0 }; }
	#fail(stderr: string): ExecResult { return { stdout: "", stderr, code: 1 }; }
}

function runtime(root: string, fake: FakeExec, messages: Array<{ message: string; options: unknown }>, env: Record<string, string | undefined> = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "socket", HERDR_PANE_ID: "workspace:root" }) {
	const deps: RuntimeDeps = {
		exec: fake.exec,
		sendMessage: (message, options) => messages.push({ message, options }),
		logger: {},
	};
	return new VisibleWorkerRuntime(deps, root, env);
}

async function register(instance: VisibleWorkerRuntime, project: string, name = "fixture") {
	const result = await instance.runProjects({ op: "add", name, path: project });
	expect(result.isError).toBeUndefined();
}

async function launchedPair() {
	const { root, project } = await fixtureRoot();
	const fake = new FakeExec(project);
	const messages: Array<{ message: string; options: unknown }> = [];
	const instance = runtime(root, fake, messages);
	await register(instance, project);
	const result = await instance.runTask({ project: "fixture", context: "shared", tasks: [{ name: "alpha", task: "A" }, { name: "beta", task: "B" }] });
	return { root, project, fake, messages, instance, result };
}

async function eventually(assertion: () => void) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try { assertion(); return; } catch { await new Promise<void>(queueMicrotask); }
	}
	assertion();
}

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

describe("launch and control", () => {
	test("preflight failures acquire no resources", async () => {
		const { root, project } = await fixtureRoot();
		const fake = new FakeExec(project);
		const missing = runtime(root, fake, [], {});
		const unknown = await missing.runTask({ project: "missing", context: "", tasks: [{ name: "one", task: "work" }] });
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toContain("Registered: (none)");
		await register(missing, project);
		expect((await missing.runTask({ project: "fixture", context: "", tasks: [{ name: "one", task: "work" }] })).isError).toBe(true);
		expect(fake.calls.some(call => call.command === "treehouse" || call.command === "herdr")).toBe(false);
	});

	test("uses Herdr's managed process context without legacy session variables", async () => {
		const { root, project } = await fixtureRoot();
		const fake = new FakeExec(project);
		const instance = runtime(root, fake, []);
		await register(instance, project);
		const result = await instance.runTask({ project: "fixture", context: "", tasks: [{ name: "one", task: "work" }] });
		expect(result.isError).toBeUndefined();
		expect(fake.calls.filter(call => call.command === "herdr").every(call => !call.args.includes("--session"))).toBe(true);
		expect(fake.calls.find(call => call.command === "herdr" && call.args.includes("create"))?.args).toContain("workspace");
	});

	test("launches concurrently and steers only named workers", async () => {
		const { fake, instance, result } = await launchedPair();
		expect(result.content[0].text).toStartWith("Visible workers launched:\n");
		expect(fake.waits.size).toBe(2);
		await instance.runWorkers({ op: "send", names: ["alpha"], message: "changed" });
		const prompts = fake.calls.filter(call => call.command === "herdr" && call.args.includes("prompt"));
		expect(prompts.filter(call => call.args.includes("changed")).map(call => call.args[call.args.indexOf("prompt") + 1])).toEqual(["pane:alpha"]);
		expect(fake.waits.has("pane:beta")).toBe(true);
	});

	test("waits for the shell and retries only Enter after a stalled submission", async () => {
		const { root, project } = await fixtureRoot();
		const fake = new FakeExec(project);
		fake.promptStallsOnce = true;
		const instance = runtime(root, fake, []);
		await register(instance, project);
		const result = await instance.runTask({ project: "fixture", context: "", tasks: [{ name: "one", task: "work" }] });
		expect(result.isError).toBeUndefined();
		const readiness = fake.calls.findIndex(call => call.command === "herdr" && call.args.includes("wait-output"));
		const start = fake.calls.findIndex(call => call.command === "herdr" && call.args.includes("start"));
		expect(readiness).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(readiness);
		expect(fake.calls.filter(call => call.command === "herdr" && call.args.includes("prompt"))).toHaveLength(1);
		expect(fake.calls.some(call => call.command === "herdr" && call.args.includes("send-keys") && call.args.at(-1) === "enter")).toBe(true);
		expect(fake.waits.has("pane:one")).toBe(true);
	});

	test("validates every target before sending", async () => {
		const { fake, instance } = await launchedPair();
		const before = fake.calls.length;
		const result = await instance.runWorkers({ op: "send", names: ["alpha", "missing"], message: "changed" });
		expect(result.isError).toBe(true);
		expect(fake.calls.length).toBe(before);
	});
});

describe("delivery", () => {
	test("fast-forwards then rebases once and wakes the root", async () => {
		const { fake, messages, instance } = await launchedPair();
		fake.settle("alpha");
		await eventually(() => expect(messages.length).toBe(1));
		fake.settle("beta");
		await eventually(() => expect(messages.length).toBe(2));
		expect(messages.every(item => item.message.startsWith("Visible worker result:\n"))).toBe(true);
		expect(messages.map(item => item.options)).toEqual([
			{ triggerTurn: true, deliverAs: "nextTurn" },
			{ triggerTurn: true, deliverAs: "nextTurn" },
		]);
		expect(fake.calls.some(call => call.command === "git" && call.args.includes("rebase") && call.args.includes("--onto"))).toBe(true);
		expect(fake.calls.filter(call => call.command === "herdr" && call.args.includes("close")).map(call => call.args.at(-1))).toEqual(["tab-alpha", "tab-beta"]);
		const returns = fake.calls.filter(call => call.command === "treehouse" && call.args[0] === "return");
		expect(returns).toHaveLength(2);
		expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
	});

	test("pushes without force or changing the registered checkout", async () => {
		const { root, project } = await fixtureRoot();
		const fake = new FakeExec(project);
		const messages: Array<{ message: string; options: unknown }> = [];
		const instance = runtime(root, fake, messages);
		await register(instance, project);
		await instance.runTask({ project: "fixture", context: "", tasks: [{ name: "push", task: "publish", pushTo: "feature/result" }] });
		fake.settle("push");
		await eventually(() => expect(messages.length).toBe(1));
		const push = fake.calls.find(call => call.command === "git" && call.args.includes("push"));
		expect(push?.args.slice(-3)).toEqual(["push", "origin", "HEAD:refs/heads/feature/result"]);
		expect(push?.args).not.toContain("--force");
		expect(fake.calls.some(call => call.command === "git" && call.args[1] === project && call.args.includes("merge"))).toBe(false);
	});

	test("retains blocked, dirty, and conflicted workers", async () => {
		const blocked = await launchedPair();
		blocked.fake.settle("alpha", "blocked");
		await eventually(() => expect(blocked.messages.some(item => item.message.includes('\"status\": \"blocked\"'))).toBe(true));
		const alphaPath = [...blocked.fake.workerHeads.keys()].find(path => path.endsWith("alpha"))!;
		const betaPath = [...blocked.fake.workerHeads.keys()].find(path => path.endsWith("beta"))!;
		blocked.fake.dirtyWorkers.add(betaPath);
		blocked.fake.settle("beta");
		await eventually(() => expect(blocked.messages.some(item => item.message.includes("uncommitted changes"))).toBe(true));
		const listed = (await blocked.instance.runWorkers({ op: "list" })).details as Array<Record<string, unknown>>;
		expect(listed.find(item => item.name === "alpha")).toMatchObject({ tab_id: "tab-alpha", pane_id: "pane:alpha", worktree: alphaPath });
		expect(listed.find(item => item.name === "beta")?.status).toBe("failed");

		const conflict = await launchedPair();
		conflict.fake.projectHead = "advanced";
		conflict.fake.rebaseFails = true;
		conflict.fake.settle("alpha");
		await eventually(() => expect(conflict.messages.some(item => item.message.includes("conflict"))).toBe(true));
		expect((await conflict.instance.runWorkers({ op: "list" })).details).toHaveLength(2);
	});

	test("dispose aborts watchers without cleanup", async () => {
		const { fake, instance } = await launchedPair();
		instance.dispose();
		await new Promise<void>(queueMicrotask);
		expect(fake.calls.some(call => call.command === "herdr" && call.args.includes("close"))).toBe(false);
		expect(fake.calls.some(call => call.command === "treehouse" && call.args[0] === "return")).toBe(false);
		expect((await instance.runWorkers({ op: "list" })).details).toEqual([]);
	});
});
