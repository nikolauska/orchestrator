import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as z from "@oh-my-pi/omptype/zod";
import {
  configurationContextSchema,
  digestSchema,
  idSchema,
  independentTargetSchema,
  shaSchema,
  storedTargetSchema,
  timestampSchema,
  type IndependentTarget,
} from "./execution";
import {
  agentBindingSchema,
  deliveryReceiptSchema,
  hostErrorSchema,
  releaseReceiptSchema,
  reportReceiptSchema,
  type HostError,
} from "./helper-protocol";
import type { WorkerRecord } from "./shared";

type StoredField = Exclude<
  keyof WorkerRecord,
  "generation" | "watch" | "launched_at" | "updated_at"
>;
type Field = readonly [
  column: string,
  field: StoredField,
  required: boolean,
  encoding?: "flag" | "json",
];
const FIELDS: readonly Field[] = [
  ["name", "name", true],
  ["scope", "scope", true],
  ["kind", "kind", true],
  ["status", "status", true],
  ["project", "project", false],
  ["project_path", "projectPath", false],
  ["role", "role", false],
  ["model", "model", false],
  ["thinking", "thinking", false],
  ["workspace_id", "workspace_id", false],
  ["tab_id", "tab_id", false],
  ["pane_id", "pane_id", false],
  ["worktree", "worktree", false],
  ["working_directory", "working_directory", false],
  ["lease_id", "lease_id", false],
  ["lease_holder", "lease_holder", false],
  ["delivery_base", "delivery_base", false],
  ["branch", "branch", false],
  ["start_from", "start_from", false],
  ["push_to", "push_to", false],
  ["hold", "hold", false, "flag"],
  ["report_path", "report_path", false],
  ["local_changes", "local_changes", false],
  ["prompt", "prompt", false],
  ["error", "error", false],
  ["controller_id", "controller_id", true],
  ["launch_id", "launch_id", true],
  ["target_json", "target", true, "json"],
  ["project_path_key", "project_path_key", false],
  ["agent_name", "agent_name", true],
  ["agent_binding_json", "agent_binding", false, "json"],
  ["phase", "phase", true],
  ["connection_json", "connection", false, "json"],
  ["status_changed_at", "status_changed_at", true],
  ["source_head", "source_head", false],
  ["worker_config_path", "worker_config_path", false],
  ["worker_config_sha256", "worker_config_sha256", false],
  ["configuration_context_json", "configuration_context", false, "json"],
  ["report_source_path", "report_source_path", false],
  ["report_receipt_json", "report_receipt", false, "json"],
  ["delivery_receipt_json", "delivery_receipt", false, "json"],
  ["cleanup_phase", "cleanup_phase", false],
  ["terminal_outcome_json", "terminal_outcome", false, "json"],
  ["agent_kind", "agent_kind", false],
];
const workerTable = (name: string) =>
  `CREATE TABLE ${name} (${FIELDS.map(([column, , required]) => `${column} TEXT${column === "name" ? " PRIMARY KEY" : required ? " NOT NULL" : ""}`).join(", ")}, launched_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
export type Owner = { pid: number; token: string; claimed_at: string };
const channelSchema = z
  .object({
    state: z.enum(["unknown", "online", "offline", "attention"]),
    lastSuccessAt: timestampSchema.optional(),
    error: hostErrorSchema.optional(),
  })
  .strict();
export const workerConnectionSchema = z
  .object({
    herdr: channelSchema,
    helper: channelSchema,
    state: z.enum(["unknown", "online", "offline", "attention"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const states = [value.herdr.state, value.helper.state];
    const expected = states.includes("attention")
      ? "attention"
      : states.includes("offline")
        ? "offline"
        : states.includes("unknown")
          ? "unknown"
          : "online";
    if (value.state !== expected)
      ctx.addIssue({
        code: "custom",
        message: "Aggregate connection state disagrees with channels",
      });
  });
export const terminalOutcomeSchema = z.union([
  z.object({ kind: z.literal("completed_with_report"), receipt: reportReceiptSchema }).strict(),
  z
    .object({ kind: z.enum(["merged", "pushed", "no_changes"]), receipt: deliveryReceiptSchema })
    .strict(),
  z
    .object({
      kind: z.enum(["closed", "discarded"]),
      authorizedAt: timestampSchema,
      releaseReceipt: releaseReceiptSchema.optional(),
    })
    .strict(),
]);
export function validateWorkerRecord(record: WorkerRecord): void {
  if (record.target) storedTargetSchema.parse(record.target);
  if (!record.target || record.target.kind === "unresolved_local") return;
  idSchema.parse(record.controller_id);
  idSchema.parse(record.launch_id);
  z.enum(["starting", "working", "blocked", "interrupted", "ready", "failed"]).parse(record.status);
  z.enum([
    "preflighted",
    "allocating",
    "opening_space",
    "starting_agent",
    "submitting_prompt",
    "running",
    "collecting_report",
    "delivering",
    "retained",
    "cleaning",
    "finished",
  ]).parse(record.phase);
  if (record.cleanup_phase)
    z.enum([
      "not_started",
      "closing_space",
      "space_closed",
      "releasing_directory",
      "directory_released",
      "complete",
    ]).parse(record.cleanup_phase);
  if (record.status_changed_at) timestampSchema.parse(record.status_changed_at);
  if (!record.agent_name || !record.phase)
    throw new Error("Resolved worker requires alias and phase");
  if (
    record.scope === "independent" &&
    (record.kind !== "scout" ||
      record.project ||
      record.projectPath ||
      record.project_path_key ||
      record.source_head ||
      record.lease_id ||
      record.lease_holder ||
      record.push_to ||
      record.start_from ||
      record.branch ||
      record.delivery_base ||
      record.hold)
  )
    throw new Error("Independent worker cannot carry project or delivery options");
  if (
    record.scope === "project" &&
    (!record.project || !record.projectPath || !record.project_path_key)
  )
    throw new Error("Project worker requires project identity");
  if (record.scope === "project" && record.worktree && (!record.lease_id || !record.lease_holder))
    throw new Error("Project directory requires lease identity");
  if (record.agent_kind !== undefined) z.literal("claude").parse(record.agent_kind);
  if (record.agent_binding) {
    agentBindingSchema.parse(record.agent_binding);
    if (
      record.agent_binding.identity !== (record.agent_kind ?? "omp") ||
      record.agent_binding.agentName !== record.agent_name ||
      record.agent_binding.session !== record.target.session ||
      record.agent_binding.paneId !== record.pane_id ||
      record.agent_binding.tabId !== record.tab_id ||
      record.agent_binding.workspaceId !== record.workspace_id ||
      record.agent_binding.cwd.path !== (record.worktree ?? record.working_directory)
    )
      throw new Error("Agent binding disagrees with worker");
  }
  const closedLegacyScout =
    record.target.kind === "local" &&
    record.scope === "project" &&
    record.kind === "scout" &&
    record.status === "failed" &&
    ["closed", "discarded"].includes(record.terminal_outcome?.kind ?? "") &&
    !!record.report_path &&
    record.report_source_path === record.report_path &&
    ["space_closed", "releasing_directory", "directory_released", "complete"].includes(
      record.cleanup_phase ?? "",
    );
  if (
    ["submitting_prompt", "running", "collecting_report", "delivering"].includes(record.phase) &&
    (!record.pane_id || !record.agent_binding) &&
    !(record.phase === "collecting_report" && closedLegacyScout)
  )
    throw new Error("Worker phase requires proven agent binding");
  if (record.connection) workerConnectionSchema.parse(record.connection);
  if (record.source_head) shaSchema.parse(record.source_head);
  if (record.worker_config_sha256) digestSchema.parse(record.worker_config_sha256);
  if (record.configuration_context) configurationContextSchema.parse(record.configuration_context);
  if (record.report_receipt) reportReceiptSchema.parse(record.report_receipt);
  if (record.delivery_receipt) deliveryReceiptSchema.parse(record.delivery_receipt);
  if (record.terminal_outcome) terminalOutcomeSchema.parse(record.terminal_outcome);
  if (["cleaning", "finished"].includes(record.phase) && !record.terminal_outcome)
    throw new Error("Cleanup requires settled outcome or explicit close/discard authorization");
  if (record.terminal_outcome?.kind === "completed_with_report" && !record.report_receipt)
    throw new Error("Scout cleanup requires durable local report receipt");
  if (
    record.terminal_outcome &&
    ["merged", "pushed", "no_changes"].includes(record.terminal_outcome.kind) &&
    !record.delivery_receipt
  )
    throw new Error("Implementation cleanup requires delivery receipt");
  if (
    ["cleaning", "finished"].includes(record.phase) &&
    record.kind === "scout" &&
    record.terminal_outcome?.kind !== "discarded" &&
    !record.report_receipt &&
    !closedLegacyScout
  )
    // The local host still refuses release unless the archive is truly absent or collected.
    throw new Error(
      "Scout report must be collected before cleanup unless explicitly discarded or safely closing a legacy archive",
    );
  for (const receipt of [record.report_receipt, record.delivery_receipt])
    if (receipt && receipt.launchId !== record.launch_id)
      throw new Error("Receipt belongs to another launch");
  if (record.terminal_outcome && "receipt" in record.terminal_outcome) {
    const receipt =
      record.terminal_outcome.kind === "completed_with_report"
        ? record.report_receipt
        : record.delivery_receipt;
    if (!isDeepStrictEqual(receipt, record.terminal_outcome.receipt))
      throw new Error("Terminal outcome disagrees with durable receipt");
    if (
      "kind" in record.terminal_outcome.receipt &&
      record.terminal_outcome.kind !== record.terminal_outcome.receipt.kind
    )
      throw new Error("Terminal delivery kind disagrees with receipt");
  }
}
export const controllerOperationSchema = z
  .object({
    id: idSchema,
    launchId: idSchema,
    workerName: z.string().min(1),
    channel: z.enum(["controller", "herdr", "helper"]),
    operation: z.string().min(1),
    requestHash: digestSchema,
    state: z.enum(["prepared", "sent", "confirmed", "uncertain", "refused"]),
    response: z.unknown().optional(),
    error: hostErrorSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type ControllerOperation = z.infer<typeof controllerOperationSchema>;
/** A supervision message for the root session; durable until the harness accepts it. */
export type SupervisorEvent = {
  id: number;
  worker?: string;
  message: string;
  createdAt: string;
  deliveredAt?: string;
};
/** Delivered events kept for `workers events` history; pending events are never pruned. */
export const EVENT_HISTORY = 200;

/** Registry writes and version changes share one transaction; a failed migration leaves legacy rows intact. */
export class WorkerStore {
  readonly #db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true, strict: true });
    try {
      this.#db.run("PRAGMA busy_timeout = 5000");
      this.#db
        .transaction(() => {
          const hasMeta = this.#db
            .query("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
            .get();
          const versionRow = hasMeta
            ? (this.#db.query("SELECT value_json FROM meta WHERE key='schema_version'").get() as {
                value_json: string;
              } | null)
            : null;
          const version = versionRow ? JSON.parse(versionRow.value_json) : 1;
          if (version !== 1 && version !== 2)
            throw new Error(`Unsupported orchestrator schema version: ${version}`);
          this.#db.run(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
          );
          if (!this.getMeta("controller_id")) this.setMeta("controller_id", crypto.randomUUID());
          idSchema.parse(this.controllerId);
          if (!this.getMeta("independent_target"))
            this.setMeta("independent_target", { machineId: "local" });
          if (version === 1) {
            const existing = this.#db.query("PRAGMA table_info(workers)").all() as {
              name: string;
            }[];
            if (existing.length) {
              this.#db.run(workerTable("workers_v2"));
              const columns = new Set(existing.map((row) => row.name));
              const old = this.#db.query("SELECT * FROM workers").all() as Record<
                string,
                string | null
              >[];
              for (const row of old) {
                const names = [...FIELDS.map(([name]) => name), "launched_at", "updated_at"];
                const values = names.map((name) =>
                  columns.has(name) ? (row[name] ?? null) : null,
                );
                const defaults: Record<string, string> = {
                  controller_id: this.controllerId,
                  launch_id: crypto.randomUUID(),
                  target_json: JSON.stringify({ kind: "unresolved_local", machineId: "local" }),
                  agent_name: row.name!,
                  phase:
                    row.status === "working" || row.status === "blocked" ? "running" : "retained",
                  status_changed_at: row.updated_at!,
                };
                for (const [name, value] of Object.entries(defaults))
                  values[names.indexOf(name)] = value;
                this.#db
                  .query(
                    `INSERT INTO workers_v2 (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
                  )
                  .run(...values);
              }
              this.#db.run("DROP TABLE workers");
              this.#db.run("ALTER TABLE workers_v2 RENAME TO workers");
            } else this.#db.run(workerTable("workers"));
          }
          // Optional columns added within schema v2; older code ignores them.
          const columns = new Set(
            (this.#db.query("PRAGMA table_info(workers)").all() as { name: string }[]).map(
              (row) => row.name,
            ),
          );
          for (const [column, , required] of FIELDS)
            if (!columns.has(column) && !required)
              this.#db.run(`ALTER TABLE workers ADD COLUMN ${column} TEXT`);
          this.#db.run(
            "CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, token TEXT NOT NULL, claimed_at TEXT NOT NULL)",
          );
          this.#db.run(
            "CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, worker_name TEXT NOT NULL, channel TEXT NOT NULL, operation TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL, response_json TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
          );
          this.#db.run(
            "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, worker_name TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT)",
          );
          this.setMeta("schema_version", 2);
        })
        .immediate();
      this.#db.run("PRAGMA journal_mode = WAL");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  get controllerId(): string {
    return idSchema.parse(this.getMeta("controller_id"));
  }
  get independentTarget(): IndependentTarget {
    return independentTargetSchema.parse(this.getMeta("independent_target"));
  }
  setIndependentTarget(target: IndependentTarget): void {
    this.setMeta("independent_target", independentTargetSchema.parse(target));
  }
  private getMeta(key: string): unknown {
    const row = this.#db.query("SELECT value_json FROM meta WHERE key = ?").get(key) as {
      value_json: string;
    } | null;
    return row ? JSON.parse(row.value_json) : undefined;
  }
  private setMeta(key: string, value: unknown): void {
    this.#db
      .query(
        "INSERT INTO meta (key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
      )
      .run(key, JSON.stringify(value));
  }
  save(record: WorkerRecord): void {
    this.#db
      .transaction(() => {
        const previous = this.#db
          .query(
            "SELECT status, status_changed_at, launched_at, controller_id, launch_id, target_json, source_head FROM workers WHERE name = ?",
          )
          .get(record.name) as {
          status: string;
          status_changed_at: string;
          launched_at: string;
          controller_id: string;
          launch_id: string;
          target_json: string;
          source_head: string | null;
        } | null;
        const now = new Date().toISOString();
        record.controller_id ??= this.controllerId;
        record.launch_id ??= crypto.randomUUID();
        record.target ??= { kind: "unresolved_local", machineId: "local" };
        record.agent_name ??= record.name;
        record.phase ??=
          record.status === "starting"
            ? "preflighted"
            : record.status === "working" || record.status === "blocked"
              ? "running"
              : "retained";
        if (previous) {
          if (
            previous.controller_id !== record.controller_id ||
            previous.launch_id !== record.launch_id
          )
            throw new Error("Worker name is reserved by another launch");
          const target = storedTargetSchema.parse(JSON.parse(previous.target_json));
          if (
            target.kind !== "unresolved_local" &&
            !isDeepStrictEqual(target, storedTargetSchema.parse(record.target))
          )
            throw new Error("A retained worker cannot change execution target");
          if (previous.source_head && previous.source_head !== record.source_head)
            throw new Error("Original source head is immutable");
        }
        record.launched_at = previous?.launched_at ?? record.launched_at ?? now;
        record.status_changed_at =
          previous && previous.status === record.status ? previous.status_changed_at : now;
        record.updated_at = now;
        validateWorkerRecord(record);
        const columns = [...FIELDS.map(([column]) => column), "launched_at", "updated_at"];
        const values = FIELDS.map(([, field, , encoding]) => {
          const value = record[field];
          return value == null
            ? null
            : encoding === "flag"
              ? value
                ? "1"
                : null
              : encoding === "json"
                ? JSON.stringify(value)
                : String(value);
        });
        this.#db
          .query(
            `INSERT INTO workers (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(name) DO UPDATE SET ${columns
              .slice(1)
              .map((column) => `${column}=excluded.${column}`)
              .join(",")}`,
          )
          .run(...values, record.launched_at, now);
      })
      .immediate();
  }
  /** Records the worker's final event in the same transaction, so a crash cannot lose both. */
  delete(name: string, message?: string): SupervisorEvent | undefined {
    return this.#db
      .transaction(() => {
        this.#db.query("DELETE FROM operations WHERE worker_name = ?").run(name);
        this.#db.query("DELETE FROM workers WHERE name = ?").run(name);
        return message === undefined ? undefined : this.#insertEvent(name, message);
      })
      .immediate();
  }
  recordEvent(worker: string | undefined, message: string): SupervisorEvent {
    return this.#insertEvent(worker, message);
  }
  #insertEvent(worker: string | undefined, message: string): SupervisorEvent {
    const createdAt = new Date().toISOString();
    const row = this.#db
      .query("INSERT INTO events (worker_name,message,created_at) VALUES (?,?,?) RETURNING id")
      .get(worker ?? null, message, createdAt) as { id: number };
    return { id: row.id, ...(worker ? { worker } : {}), message, createdAt };
  }
  markDelivered(ids: number[]): void {
    if (!ids.length) return;
    const deliveredAt = new Date().toISOString();
    this.#db
      .transaction(() => {
        const mark = this.#db.query(
          "UPDATE events SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL",
        );
        for (const id of ids) mark.run(deliveredAt, id);
        this.#db
          .query(
            "DELETE FROM events WHERE delivered_at IS NOT NULL AND id NOT IN (SELECT id FROM events WHERE delivered_at IS NOT NULL ORDER BY id DESC LIMIT ?)",
          )
          .run(EVENT_HISTORY);
      })
      .immediate();
  }
  pendingEvents(): SupervisorEvent[] {
    return this.#events("SELECT * FROM events WHERE delivered_at IS NULL ORDER BY id");
  }
  /** Newest events last, pending ones included. */
  recentEvents(limit = EVENT_HISTORY): SupervisorEvent[] {
    return this.#events(
      "SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id",
      limit,
    );
  }
  #events(sql: string, ...params: number[]): SupervisorEvent[] {
    return (
      this.#db.query(sql).all(...params) as {
        id: number;
        worker_name: string | null;
        message: string;
        created_at: string;
        delivered_at: string | null;
      }[]
    ).map((row) => ({
      id: row.id,
      ...(row.worker_name ? { worker: row.worker_name } : {}),
      message: row.message,
      createdAt: row.created_at,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    }));
  }
  has(name: string): boolean {
    return !!this.#db.query("SELECT 1 FROM workers WHERE name = ?").get(name);
  }
  all(): WorkerRecord[] {
    return (
      this.#db.query("SELECT * FROM workers ORDER BY launched_at, name").all() as Record<
        string,
        string | null
      >[]
    ).map((row) => {
      const record: Record<string, unknown> = {
        generation: 0,
        launched_at: row.launched_at,
        updated_at: row.updated_at,
      };
      for (const [column, field, , encoding] of FIELDS)
        if (row[column] != null)
          record[field] =
            encoding === "flag"
              ? row[column] === "1"
              : encoding === "json"
                ? JSON.parse(row[column])
                : row[column];
      validateWorkerRecord(record as WorkerRecord);
      return record as WorkerRecord;
    });
  }
  saveOperation(operation: ControllerOperation): void {
    controllerOperationSchema.parse(operation);
    this.#db
      .transaction(() => {
        const previous = this.operation(operation.id);
        if (
          previous &&
          (previous.launchId !== operation.launchId ||
            previous.workerName !== operation.workerName ||
            previous.channel !== operation.channel ||
            previous.operation !== operation.operation ||
            previous.requestHash !== operation.requestHash)
        )
          throw new Error("Operation identity cannot be reused");
        this.#db
          .query(
            "INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,response_json=excluded.response_json,error_json=excluded.error_json,updated_at=excluded.updated_at",
          )
          .run(
            operation.id,
            operation.launchId,
            operation.workerName,
            operation.channel,
            operation.operation,
            operation.requestHash,
            operation.state,
            operation.response === undefined ? null : JSON.stringify(operation.response),
            operation.error ? JSON.stringify(operation.error) : null,
            operation.createdAt,
            operation.updatedAt,
          );
      })
      .immediate();
  }
  operation(id: string): ControllerOperation | undefined {
    return this.operations().find((operation) => operation.id === id);
  }
  operations(worker?: { name: string; launchId: string | undefined }): ControllerOperation[] {
    if (worker && !worker.launchId) return [];
    const rows = worker
      ? this.#db
          .query(
            "SELECT * FROM operations WHERE worker_name = ? AND launch_id = ? ORDER BY created_at,rowid",
          )
          .all(worker.name, worker.launchId!)
      : this.#db.query("SELECT * FROM operations ORDER BY created_at,rowid").all();
    return (rows as Record<string, string | null>[]).map((row) =>
      controllerOperationSchema.parse({
        id: row.id,
        launchId: row.launch_id,
        workerName: row.worker_name,
        channel: row.channel,
        operation: row.operation,
        requestHash: row.request_hash,
        state: row.state,
        ...(row.response_json ? { response: JSON.parse(row.response_json) } : {}),
        ...(row.error_json ? { error: JSON.parse(row.error_json) as HostError } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }
  deleteOperation(id: string): void {
    this.#db.query("DELETE FROM operations WHERE id = ?").run(id);
  }
  close(): void {
    this.#db.close();
  }
  claim(token: string, pid: number, alive: (pid: number) => boolean): Owner {
    return this.#db
      .transaction(() => {
        const owner = this.owner();
        if (owner && owner.token !== token && alive(owner.pid)) return owner;
        const claimed = { pid, token, claimed_at: new Date().toISOString() };
        this.#db
          .query(
            "INSERT INTO owner (id,pid,token,claimed_at) VALUES (1,$pid,$token,$claimed_at) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token,claimed_at=excluded.claimed_at",
          )
          .run(claimed);
        return claimed;
      })
      .immediate();
  }
  release(token: string): void {
    this.#db.query("DELETE FROM owner WHERE token = ?").run(token);
  }
  owner(): Owner | undefined {
    return (this.#db.query("SELECT pid,token,claimed_at FROM owner WHERE id=1").get() ??
      undefined) as Owner | undefined;
  }
}
