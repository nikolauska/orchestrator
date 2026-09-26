import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkerRecord } from "./shared";

type StoredField = Exclude<keyof WorkerRecord, "generation" | "watch">;

// Column names stay snake_case so the table reads naturally in sqlite tooling.
const FIELDS: ReadonlyArray<readonly [column: string, field: StoredField, required: boolean]> = [
  ["name", "name", true],
  ["scope", "scope", true],
  ["kind", "kind", true],
  ["status", "status", true],
  ["project", "project", false],
  ["project_path", "projectPath", false],
  ["role", "role", false],
  ["workspace_id", "workspace_id", true],
  ["tab_id", "tab_id", true],
  ["pane_id", "pane_id", true],
  ["worktree", "worktree", false],
  ["working_directory", "working_directory", false],
  ["lease_id", "lease_id", false],
  ["lease_holder", "lease_holder", false],
  ["delivery_base", "delivery_base", false],
  ["branch", "branch", false],
  ["push_to", "push_to", false],
  ["report_path", "report_path", false],
  ["local_changes", "local_changes", false],
  ["error", "error", false],
];

/** Durable registry of live and retained workers, so an OMP restart can resume or close them. */
export class WorkerStore {
  readonly #db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS workers (${FIELDS.map(
        ([column, , required]) =>
          `${column} TEXT${column === "name" ? " PRIMARY KEY" : required ? " NOT NULL" : ""}`,
      ).join(", ")}, launched_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
  }

  save(record: WorkerRecord): void {
    const columns = FIELDS.map(([column]) => column);
    const now = new Date().toISOString();
    const values: Record<string, string | null> = { launched_at: now, updated_at: now };
    for (const [column, field] of FIELDS)
      values[column] = (record[field] as string | undefined) ?? null;
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
        const record: Record<string, unknown> = { generation: 0 };
        for (const [column, field] of FIELDS) {
          const value = (row as Record<string, unknown>)[column];
          if (value !== null) record[field] = value;
        }
        return record as WorkerRecord;
      });
  }
}
