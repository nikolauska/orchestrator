import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkerRecord } from "./shared";

type StoredField = Exclude<
  keyof WorkerRecord,
  "generation" | "watch" | "launched_at" | "updated_at"
>;

// Column names stay snake_case so the table reads naturally in sqlite tooling.
const FIELDS: ReadonlyArray<
  readonly [column: string, field: StoredField, required: boolean, flag?: true]
> = [
  ["name", "name", true],
  ["scope", "scope", true],
  ["kind", "kind", true],
  ["status", "status", true],
  ["project", "project", false],
  ["project_path", "projectPath", false],
  ["role", "role", false],
  ["model", "model", false],
  ["thinking", "thinking", false],
  ["workspace_id", "workspace_id", true],
  ["tab_id", "tab_id", true],
  ["pane_id", "pane_id", true],
  ["worktree", "worktree", false],
  ["working_directory", "working_directory", false],
  ["lease_id", "lease_id", false],
  ["lease_holder", "lease_holder", false],
  ["delivery_base", "delivery_base", false],
  ["branch", "branch", false],
  ["start_from", "start_from", false],
  ["push_to", "push_to", false],
  ["hold", "hold", false, true],
  ["report_path", "report_path", false],
  ["local_changes", "local_changes", false],
  ["prompt", "prompt", false],
  ["error", "error", false],
];

export type Owner = { pid: number; token: string; claimed_at: string };

/** Durable registry of live and retained workers, so an OMP restart can resume or close them. */
export class WorkerStore {
  readonly #db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    // Concurrent sessions contend for the owner row; wait briefly instead of failing on a lock.
    this.#db.run("PRAGMA busy_timeout = 5000");
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS workers (${FIELDS.map(
        ([column, , required]) =>
          `${column} TEXT${column === "name" ? " PRIMARY KEY" : required ? " NOT NULL" : ""}`,
      ).join(", ")}, launched_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    // Databases created by earlier versions lack newer optional columns.
    const existing = new Set(
      this.#db
        .query("PRAGMA table_info(workers)")
        .all()
        .map((row) => (row as { name: string }).name),
    );
    for (const [column] of FIELDS)
      if (!existing.has(column)) this.#db.run(`ALTER TABLE workers ADD COLUMN ${column} TEXT`);
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, token TEXT NOT NULL, claimed_at TEXT NOT NULL)",
    );
  }

  save(record: WorkerRecord): void {
    const columns = FIELDS.map(([column]) => column);
    const now = new Date().toISOString();
    record.launched_at ??= now;
    record.updated_at = now;
    const values: Record<string, string | null> = {
      launched_at: record.launched_at,
      updated_at: now,
    };
    for (const [column, field, , flag] of FIELDS) {
      const value = record[field];
      values[column] = flag ? (value ? "1" : null) : ((value as string | undefined) ?? null);
    }
    this.#db
      .query(
        `INSERT INTO workers (${columns.join(", ")}, launched_at, updated_at)
         VALUES (${columns.map((column) => `$${column}`).join(", ")}, $launched_at, $updated_at)
         ON CONFLICT(name) DO UPDATE SET ${[...columns.slice(1), "updated_at"]
           .map((column) => `${column} = excluded.${column}`)
           .join(", ")}`,
      )
      .run(values);
  }

  delete(name: string): void {
    this.#db.query("DELETE FROM workers WHERE name = $name").run({ name });
  }

  all(): WorkerRecord[] {
    return this.#db
      .query("SELECT * FROM workers ORDER BY launched_at, name")
      .all()
      .map((row) => {
        const values = row as Record<string, unknown>;
        const record: Record<string, unknown> = {
          generation: 0,
          launched_at: values.launched_at,
          updated_at: values.updated_at,
        };
        for (const [column, field, , flag] of FIELDS) {
          const value = values[column];
          if (value !== null) record[field] = flag ? value === "1" : value;
        }
        return record as WorkerRecord;
      });
  }

  /**
   * Makes this session the single supervisor of the recorded workers. Two supervising sessions
   * would both deliver, close, and report every finished worker, so a live owner is never replaced.
   */
  claim(token: string, pid: number, alive: (pid: number) => boolean): Owner {
    return this.#db
      .transaction(() => {
        const owner = this.owner();
        if (owner && owner.token !== token && alive(owner.pid)) return owner;
        const claimed = { pid, token, claimed_at: new Date().toISOString() };
        this.#db
          .query(
            "INSERT INTO owner (id, pid, token, claimed_at) VALUES (1, $pid, $token, $claimed_at) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, token = excluded.token, claimed_at = excluded.claimed_at",
          )
          .run(claimed);
        return claimed;
      })
      .immediate();
  }

  release(token: string): void {
    this.#db.query("DELETE FROM owner WHERE token = $token").run({ token });
  }

  owner(): Owner | undefined {
    return (this.#db.query("SELECT pid, token, claimed_at FROM owner WHERE id = 1").get() ??
      undefined) as Owner | undefined;
  }
}
