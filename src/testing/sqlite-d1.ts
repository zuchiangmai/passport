// A D1Database stand-in on node:sqlite for integration tests. Implements the subset
// Better Auth's D1 dialect and this Worker use: prepare/bind/first/all/run/raw, batch, exec.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;

function value(input: unknown): SQLInputValue {
  if (input === undefined || input === null) return null;
  if (typeof input === "boolean") return input ? 1 : 0;
  if (input instanceof Date) return input.toISOString();
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return input as SQLInputValue;
}

class Statement {
  readonly db: DatabaseSync;
  readonly sql: string;
  readonly params: SQLInputValue[];

  constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params.map(value));
  }

  execute() {
    const statement = this.db.prepare(this.sql);
    if (statement.columns().length > 0) {
      const results = statement.all(...this.params).map((row) => ({ ...row }) as Row);
      return { results, success: true, meta: { changes: results.length, last_row_id: 0, duration: 0 } };
    }
    const { changes, lastInsertRowid } = statement.run(...this.params);
    return { results: [] as Row[], success: true, meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid), duration: 0 } };
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }

  async first(column?: string) {
    const row = this.execute().results[0] ?? null;
    if (!column) return row;
    return row ? (row[column] ?? null) : null;
  }

  async raw() {
    return this.execute().results.map((row) => Object.values(row));
  }
}

export class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(sql: string) {
    return new Statement(this.sqlite, sql);
  }

  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("not supported");
  }

  withSession() {
    return this;
  }

  /**
   * Applies migrations/*.sql in order, like `wrangler d1 migrations apply`.
   * `before` stops at that file, e.g. "0002" gives main's production schema.
   */
  static migrated(options: { before?: string } = {}) {
    const d1 = new SqliteD1();
    const directory = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      if (options.before && file >= options.before) break;
      d1.sqlite.exec(readFileSync(join(directory, file), "utf8"));
    }
    return d1;
  }

  asD1() {
    return this as unknown as D1Database;
  }
}
