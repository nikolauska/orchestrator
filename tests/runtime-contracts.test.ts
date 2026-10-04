import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkerStore, type ControllerOperation } from "../.omp/runtime/store";
import { normalizeProjectRegistry, readProjectRegistry } from "../.omp/runtime/project-registry";
import { validateExecutionTarget } from "../.omp/runtime/execution";
import {
  PROTOCOL,
  ReportStreamValidator,
  validateHostRequest,
  validateHostReply,
  validateHostResult,
  validateReportFrame,
  type HostRequest,
} from "../.omp/runtime/helper-protocol";
import type { WorkerRecord } from "../.omp/runtime/shared";
import { cleanup, executionTargetFixture, fixtureRoot } from "./test-helpers";

afterEach(cleanup);
const uuid = "12345678-1234-4123-8123-123456789abc";
const timestamp = "2026-09-30T12:00:00.000Z";
const digest = "a".repeat(64);
function partial(name = "pending"): WorkerRecord {
  return {
    scope: "independent",
    kind: "scout",
    name,
    status: "starting",
    generation: 0,
    target: executionTargetFixture(),
    phase: "preflighted",
    agent_name: "o12345678-12345678123441238123",
  };
}
function request<Op extends HostRequest["op"]>(
  op: Op,
  args: unknown,
  extra: Record<string, unknown> = {},
): HostRequest<Op> {
  return validateHostRequest({
    protocol: PROTOCOL,
    version: 1,
    requestId: uuid,
    controllerId: uuid,
    expectedHostId: uuid,
    op,
    args,
    ...extra,
  }) as HostRequest<Op>;
}
function legacy(path: string, invalid = false): void {
  const db = new Database(path);
  db.run(
    "CREATE TABLE workers (name TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,workspace_id TEXT NOT NULL,tab_id TEXT NOT NULL,pane_id TEXT NOT NULL,lease_id TEXT,lease_holder TEXT,updated_at TEXT,launched_at TEXT NOT NULL)",
  );
  db.query("INSERT INTO workers VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "legacy",
    "project",
    "implementation",
    "working",
    "workspace",
    "tab",
    "pane",
    "lease",
    "omp-orchestrator:legacy",
    invalid ? null : timestamp,
    timestamp,
  );
  db.run(
    "CREATE TABLE owner (id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL,claimed_at TEXT NOT NULL)",
  );
  db.query("INSERT INTO owner VALUES (1,?,?,?)").run(123, "owner-token", timestamp);
  db.close();
}

describe("durable schema v2", () => {
  test("migrates legacy rows, aliases and supervisor owner without changing lease identity", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "workers.db");
    legacy(path);
    const store = new WorkerStore(path);
    const row = store.all()[0]!;
    expect(row).toMatchObject({
      name: "legacy",
      lease_id: "lease",
      lease_holder: "omp-orchestrator:legacy",
      agent_name: "legacy",
      target: { kind: "unresolved_local", machineId: "local" },
      status_changed_at: timestamp,
      phase: "running",
      pane_id: "pane",
    });
    expect(row.source_head).toBeUndefined();
    expect(store.owner()).toEqual({ pid: 123, token: "owner-token", claimed_at: timestamp });
    const controllerId = store.controllerId;
    store.close();
    const reopened = new WorkerStore(path);
    expect(reopened.controllerId).toBe(controllerId);
    expect(reopened.all()[0]!.launch_id).toBe(row.launch_id);
    reopened.close();
    const db = new Database(path);
    const columns = db.query("PRAGMA table_info(workers)").all() as {
      name: string;
      notnull: number;
    }[];
    expect(
      columns
        .filter((c) => ["pane_id", "tab_id", "workspace_id"].includes(c.name))
        .map((c) => c.notnull),
    ).toEqual([0, 0, 0]);
    db.close();
  });
  test("rolls back a failed migration, leaving old rows and owner intact", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "workers.db");
    legacy(path, true);
    expect(() => new WorkerStore(path)).toThrow();
    const db = new Database(path);
    expect(db.query("SELECT lease_holder FROM workers").get()).toEqual({
      lease_holder: "omp-orchestrator:legacy",
    });
    expect(db.query("SELECT token FROM owner").get()).toEqual({ token: "owner-token" });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name IN ('meta','workers_v2')").all(),
    ).toEqual([]);
    db.close();
  });
  test("refuses future schema versions without rewriting the database", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "future.db");
    const db = new Database(path);
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY,value_json TEXT NOT NULL)");
    db.run("INSERT INTO meta VALUES ('schema_version','3')");
    db.close();
    const before = await readFile(path);
    expect(() => new WorkerStore(path)).toThrow("Unsupported");
    expect(await readFile(path)).toEqual(before);
  });
  test("partial launch reserves its name across reopen and preserves independent default", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "partial.db");
    let store = new WorkerStore(path);
    const record = partial();
    store.save(record);
    store.setIndependentTarget({
      machineId: "windows",
      hostId: uuid,
      sshTarget: "workbox",
      session: "agents",
    });
    store.close();
    store = new WorkerStore(path);
    expect(store.has("pending")).toBe(true);
    expect(store.all()[0]).toMatchObject({
      status: "starting",
      phase: "preflighted",
      launch_id: record.launch_id,
    });
    expect(store.all()[0]!.pane_id).toBeUndefined();
    expect(store.independentTarget).toMatchObject({ machineId: "windows" });
    store.close();
  });
  test("connectivity updates leave lifecycle time unchanged; real status changes advance it", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "connection.db");
    const store = new WorkerStore(path);
    const record = partial();
    store.save(record);
    store.close();
    const db = new Database(path);
    db.query("UPDATE workers SET status_changed_at = ?").run(timestamp);
    db.close();
    const reopened = new WorkerStore(path);
    const loaded = reopened.all()[0]!;
    loaded.connection = {
      herdr: { state: "online", lastSuccessAt: timestamp },
      helper: { state: "offline" },
      state: "offline",
    };
    reopened.save(loaded);
    expect(loaded.status_changed_at).toBe(timestamp);
    loaded.status = "failed";
    reopened.save(loaded);
    expect(loaded.status_changed_at).not.toBe(timestamp);
    reopened.close();
  });
  test("journals retain intent across reopen and reject identity reuse", async () => {
    const { root } = await fixtureRoot();
    const path = join(root, "operations.db");
    const store = new WorkerStore(path);
    const operation: ControllerOperation = {
      id: uuid,
      launchId: uuid,
      workerName: "pending",
      channel: "helper",
      operation: "worker.allocate",
      requestHash: digest,
      state: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.saveOperation(operation);
    expect(() => store.saveOperation({ ...operation, requestHash: "b".repeat(64) })).toThrow(
      "identity",
    );
    store.saveOperation({ ...operation, state: "uncertain" });
    store.close();
    const reopened = new WorkerStore(path);
    expect(reopened.operations({ name: "pending", launchId: uuid })).toEqual([
      { ...operation, state: "uncertain" },
    ]);
    reopened.close();
  });
  test("reserved names cannot be reused and retained workers cannot be rerouted", async () => {
    const { root } = await fixtureRoot();
    const store = new WorkerStore(join(root, "identity.db"));
    const record = partial();
    store.save(record);
    expect(() => store.save(partial())).toThrow("reserved");
    expect(() => store.save({ ...record, target: executionTargetFixture("win32") })).toThrow(
      "target",
    );
    expect(store.all()[0]!.target).toEqual(record.target);
    store.close();
  });
  test("refuses destructive phases without binding, lease or settlement evidence", async () => {
    const { root } = await fixtureRoot();
    const store = new WorkerStore(join(root, "invalid.db"));
    expect(() => store.save({ ...partial(), phase: "submitting_prompt", pane_id: "pane" })).toThrow(
      "binding",
    );
    expect(() => store.save({ ...partial(), phase: "cleaning" })).toThrow("settled");
    expect(() => store.save({ ...partial(), source_head: "a".repeat(40) })).toThrow("Independent");
    expect(() =>
      store.save({
        ...partial(),
        phase: "cleaning",
        terminal_outcome: { kind: "closed", authorizedAt: timestamp },
      }),
    ).toThrow("collected");
    expect(store.has("pending")).toBe(false);
    store.close();
    const discardStore = new WorkerStore(join(root, "discard.db"));
    const discarded = {
      ...partial(),
      target: executionTargetFixture("win32", "remote"),
      phase: "cleaning" as const,
      terminal_outcome: { kind: "discarded" as const, authorizedAt: timestamp },
      report_path: "C:\\Controller\\reports\\report.md",
      report_source_path: "D:\\Host Staging\\report.md",
    };
    discardStore.save(discarded);
    expect(discardStore.all()[0]).toMatchObject({
      report_path: discarded.report_path,
      report_source_path: discarded.report_source_path,
      terminal_outcome: discarded.terminal_outcome,
    });
    discardStore.close();
  });
});

describe("registry migration", () => {
  test("preserves a project named version and unavailable Windows paths without probing or rewriting", async () => {
    const { root } = await fixtureRoot();
    await mkdir(join(root, ".omp"));
    const raw = JSON.stringify({ version: "Z:\\Offline\\version", app: "Z:\\Offline\\app" });
    await writeFile(join(root, ".omp", "projects.json"), raw);
    await writeFile(join(root, ".omp", "projects-root"), "Z:\\Unavailable Root\r\n");
    const result = await readProjectRegistry(root);
    expect(result.registry.projects.version).toEqual({
      machine: "local",
      path: "Z:\\Offline\\version",
    });
    expect(result.registry.roots.local).toEqual({ path: "Z:\\Unavailable Root" });
    expect(result.issues.map((i) => `${i.kind}:${i.name}`)).toEqual([
      "project:version",
      "project:app",
      "root:local",
    ]);
    expect(await readFile(join(root, ".omp", "projects.json"), "utf8")).toBe(raw);
    expect(await readFile(join(root, ".omp", "projects-root"), "utf8")).toBe(
      "Z:\\Unavailable Root\r\n",
    );
  });
  test("refuses unknown envelopes and mixed registries", () => {
    expect(() => normalizeProjectRegistry({ version: 3, projects: {} })).toThrow("Unsupported");
    expect(() => normalizeProjectRegistry({ version: 2, app: "/app" })).toThrow();
  });
  test("requires remote bindings, forbids local bindings and preserves opaque keys", () => {
    const registry = {
      version: 2 as const,
      projects: {
        app: { machine: "local" as const, path: "C:\\Code\\App", pathKey: "CaseSensitiveIdentity" },
      },
      roots: {},
    };
    expect(normalizeProjectRegistry(registry).registry).toEqual(registry);
    expect(() =>
      normalizeProjectRegistry({
        ...registry,
        projects: {
          app: {
            ...registry.projects.app,
            binding: { hostId: uuid, session: "agents", sshTarget: "host" },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      normalizeProjectRegistry({
        ...registry,
        projects: { app: { machine: "remote", path: "/app", pathKey: "key" } },
      }),
    ).toThrow();
  });
});

describe("execution and helper contracts", () => {
  test("local and remote targets accept Windows and reject mismatched or relative native paths", () => {
    const local = executionTargetFixture("win32");
    expect(validateExecutionTarget(local)).toEqual(local);
    expect(validateExecutionTarget(executionTargetFixture("win32", "windows")).os).toBe("win32");
    expect(() => validateExecutionTarget({ ...local, pathStyle: "posix" })).toThrow();
    expect(() =>
      validateExecutionTarget({
        ...local,
        workerConfig: { ...local.workerConfig, path: "C:relative" },
      }),
    ).toThrow();
    expect(() => validateExecutionTarget({ ...local, machineId: "" })).toThrow();
  });
  test("strict request unions reject unknown fields, missing identities and independent project options", () => {
    const base = {
      protocol: PROTOCOL,
      version: 1,
      requestId: uuid,
      controllerId: uuid,
      expectedHostId: uuid,
      op: "worker.allocate",
      operationId: uuid,
      args: { launchId: uuid, kind: "scout", scope: "independent", forbiddenRoots: [] },
    };
    expect(validateHostRequest(base).op).toBe("worker.allocate");
    for (const bad of [
      { ...base, extra: true },
      { ...base, operationId: undefined },
      { ...base, expectedHostId: undefined },
      { ...base, requestId: "not-uuid" },
      { ...base, args: { ...base.args, projectPath: "/project" } },
    ])
      expect(() => validateHostRequest(bad)).toThrow();
    expect(() =>
      request("project.snapshot", {
        projectPath: "/project",
        tasks: [{ name: "app", kind: "implementation", extra: true }],
      }),
    ).toThrow();
    expect(() =>
      request("preflight", { scope: "independent", requiredOverlaySha256: "A".repeat(64) }),
    ).toThrow();
  });
  test("validates requested result rather than accepting another operation's result or host", () => {
    const req = request(
      "project.create",
      { path: "/project", registrationId: uuid },
      { operationId: uuid },
    );
    const reply = {
      protocol: PROTOCOL,
      version: 1,
      requestId: uuid,
      hostId: uuid,
      ok: true,
      result: {
        registrationId: uuid,
        project: { path: "/project", pathKey: "key" },
        head: "a".repeat(40),
      },
    };
    expect(validateHostReply(req, reply).ok).toBe(true);
    for (const result of [
      { launchId: uuid, forgotten: true },
      { ...reply.result, head: "short" },
      { ...reply.result, extra: true },
    ])
      expect(() => validateHostReply(req, { ...reply, result })).toThrow();
    expect(() => validateHostReply(req, { ...reply, hostId: crypto.randomUUID() })).toThrow(
      "identity",
    );
    expect(() =>
      validateHostReply(request("path.validate", { path: "/project", kind: "git_root" }), {
        ...reply,
        result: { path: { path: "/project", pathKey: "key" } },
      }),
    ).toThrow("confirmation");
  });
  test("recorded operation results require their original operation schema", () => {
    const value = {
      operationId: uuid,
      requestHash: digest,
      state: "confirmed" as const,
      result: { launchId: uuid, forgotten: true },
    };
    expect(() => validateHostResult("operation.get", value)).toThrow("original");
    expect(validateHostResult("operation.get", value, { [uuid]: "worker.forget" })).toEqual(value);
    expect(() =>
      validateHostResult("operation.get", value, { [uuid]: "worker.release" }),
    ).toThrow();
  });
  test("stream frame schemas reject extra fields, malformed base64 and unsafe offsets", () => {
    const frame = {
      protocol: PROTOCOL,
      version: 1,
      requestId: uuid,
      hostId: uuid,
      type: "chunk",
      offset: 0,
      bytesBase64: "aGk=",
    };
    for (const bad of [
      { ...frame, extra: true },
      { ...frame, bytesBase64: "$$==" },
      { ...frame, offset: -1 },
      { ...frame, offset: Number.MAX_SAFE_INTEGER + 1 },
      { ...frame, bytesBase64: Buffer.alloc(65537).toString("base64") },
    ])
      expect(() => validateReportFrame(bad)).toThrow();
  });
  test("stream sequencing validates bytes, UTF-8, identity and digest without normalizing Windows CRLF", () => {
    const req = request("report.read", { launchId: uuid });
    const bytes = Buffer.from("# Report\r\nUnicode: é\r\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const base = { protocol: PROTOCOL, version: 1, requestId: uuid, hostId: uuid };
    const begin = {
      ...base,
      type: "begin",
      launchId: uuid,
      filename: "report.md",
      byteCount: bytes.length,
      fileIdentity: "file:1",
    };
    const chunk = { ...base, type: "chunk", offset: 0, bytesBase64: bytes.toString("base64") };
    const end = { ...base, type: "end", byteCount: bytes.length, sha256, fileIdentity: "file:1" };
    const stream = new ReportStreamValidator(req);
    stream.accept(begin);
    stream.accept(chunk);
    stream.accept(end);
    stream.finish();
    expect(() => stream.accept(end)).toThrow();
    const split = new ReportStreamValidator(req);
    split.accept(begin);
    const unicodeByte = bytes.indexOf(0xc3) + 1;
    split.accept({ ...chunk, bytesBase64: bytes.subarray(0, unicodeByte).toString("base64") });
    split.accept({
      ...chunk,
      offset: unicodeByte,
      bytesBase64: bytes.subarray(unicodeByte).toString("base64"),
    });
    split.accept(end);
    split.finish();
    for (const bad of [
      { ...chunk, offset: 1 },
      { ...chunk, hostId: crypto.randomUUID() },
    ]) {
      const peer = new ReportStreamValidator(req);
      peer.accept(begin);
      expect(() => peer.accept(bad)).toThrow();
    }
    for (const bad of [
      { ...end, sha256: digest },
      { ...end, fileIdentity: "file:2" },
      { ...end, byteCount: 1 },
    ]) {
      const peer = new ReportStreamValidator(req);
      peer.accept(begin);
      peer.accept(chunk);
      expect(() => peer.accept(bad)).toThrow();
    }
    const incomplete = new ReportStreamValidator(req);
    incomplete.accept(begin);
    expect(() => incomplete.finish()).toThrow();
    const invalid = new ReportStreamValidator(req);
    invalid.accept({ ...begin, byteCount: 1 });
    expect(() => invalid.accept({ ...chunk, bytesBase64: "/w==" })).toThrow();
    const whitespace = Buffer.from(" \r\n");
    const empty = new ReportStreamValidator(req);
    empty.accept({ ...begin, byteCount: whitespace.length });
    empty.accept({ ...chunk, bytesBase64: whitespace.toString("base64") });
    expect(() =>
      empty.accept({
        ...end,
        byteCount: whitespace.length,
        sha256: createHash("sha256").update(whitespace).digest("hex"),
      }),
    ).toThrow();
  });
});
