// A D1Database stand-in over node:sqlite (Node ≥ 22.13), so the guest layer's
// real SQL — including the stage clock and the CHECK constraints — runs in
// tests against the real schema.sql rather than a hand-rolled mock.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");

class FakeStatement {
  private values: unknown[] = [];
  constructor(private readonly db: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]) {
    this.values = values.map((v) => (v === undefined ? null : v));
    return this;
  }
  /** D1 binds `?N` by number (and a number may repeat); node:sqlite's
   *  positional API does not, so rewrite to anonymous `?` and expand. */
  private compile(): { stmt: ReturnType<DatabaseSync["prepare"]>; params: unknown[] } {
    const params: unknown[] = [];
    const sql = this.sql.replace(/\?(\d+)/g, (_, n: string) => {
      params.push(this.values[Number(n) - 1] ?? null);
      return "?";
    });
    return { stmt: this.db.prepare(sql), params };
  }
  async first<T>(): Promise<T | null> {
    const { stmt, params } = this.compile();
    return (stmt.get(...(params as never[])) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    const { stmt, params } = this.compile();
    return { results: stmt.all(...(params as never[])) as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const { stmt, params } = this.compile();
    const r = stmt.run(...(params as never[]));
    return { meta: { changes: Number(r.changes) } };
  }
}

export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(schemaPath, "utf8"));
  return {
    prepare: (sql: string) => new FakeStatement(db, sql) as unknown as D1PreparedStatement,
    batch: async (stmts: D1PreparedStatement[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}
