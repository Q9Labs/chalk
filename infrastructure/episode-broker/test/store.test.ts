// @ts-expect-error The Node SQLite runtime is used by this test, while the worker package omits Node typings.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { SqlStorage, SqlStorageCursor } from "cloudflare:workers";
import { LeaseStore, type LeaseRecord } from "../src/store";

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("LeaseStore", () => {
  it("creates the current schema on a fresh database", () => {
    const sql = sqliteStorage();
    const store = new LeaseStore(sql);

    expect(columnNames(sql)).toEqual(["singleton", "log_id", "created_at", "expires_at", "episode_id", "creator_credential_id", "space_id", "space_origin"]);
    expect(store.lease()).toBeUndefined();
  });

  it("migrates an old lease row to legacy origin without a Space id", () => {
    const sql = sqliteStorage(oldEpisodeLeaseSchema);
    sql.exec("INSERT INTO episode_lease (singleton, log_id, created_at, expires_at, creator_credential_id) VALUES (1, ?, ?, ?, ?)", "log-1", 10, 20, "credential-1");

    const store = new LeaseStore(sql);

    expect(store.lease()).toEqual<LeaseRecord>({
      logId: "log-1",
      createdAt: 10,
      expiresAt: 20,
      creatorCredentialId: "credential-1",
      spaceOrigin: "legacy",
    });
    expect(sql.exec<{ readonly space_id: string | null; readonly space_origin: string | null }>("SELECT space_id, space_origin FROM episode_lease").one()).toEqual({ space_id: null, space_origin: "legacy" });
  });

  it("keeps migration idempotent across restarts", () => {
    const sql = sqliteStorage(oldEpisodeLeaseSchema);
    new LeaseStore(sql);
    const restarted = new LeaseStore(sql);

    expect(columnNames(sql)).toEqual(expect.arrayContaining(["space_id", "space_origin"]));
    expect(columnNames(sql)).toHaveLength(8);
    expect(restarted.lease()).toBeUndefined();
  });

  it("completes a partial migration when one new column already exists", () => {
    const sql = sqliteStorage(oldEpisodeLeaseSchema.replace("\n)", ",\n  space_id TEXT\n)"));

    new LeaseStore(sql);

    expect(columnNames(sql)).toEqual(expect.arrayContaining(["space_id", "space_origin"]));
    expect(columnNames(sql)).toHaveLength(8);

    const originOnlySql = sqliteStorage(oldEpisodeLeaseSchema.replace("\n)", ",\n  space_origin TEXT\n)"));

    new LeaseStore(originOnlySql);

    expect(columnNames(originOnlySql)).toEqual(expect.arrayContaining(["space_id", "space_origin"]));
    expect(columnNames(originOnlySql)).toHaveLength(8);
  });

  it("preserves an isolated provisional lease with a null Space id", () => {
    const sql = sqliteStorage();
    const store = new LeaseStore(sql);
    store.createLease({ logId: "log-2", createdAt: 30, expiresAt: 40, creatorCredentialId: "credential-2", spaceOrigin: "isolated" });

    expect(store.lease()).toEqual<LeaseRecord>({
      logId: "log-2",
      createdAt: 30,
      expiresAt: 40,
      creatorCredentialId: "credential-2",
      spaceOrigin: "isolated",
    });
    expect(sql.exec<{ readonly space_id: string | null; readonly space_origin: string | null }>("SELECT space_id, space_origin FROM episode_lease").one()).toEqual({ space_id: null, space_origin: "isolated" });
  });

  it("reads and writes an isolated Space binding", () => {
    const sql = sqliteStorage();
    const store = new LeaseStore(sql);
    store.createLease({ logId: "log-3", createdAt: 50, expiresAt: 60, creatorCredentialId: "credential-3", spaceOrigin: "isolated", spaceId: "space-3" });

    expect(store.lease()).toMatchObject({ spaceOrigin: "isolated", spaceId: "space-3" });
    store.setSpace("space-4");
    expect(store.lease()).toMatchObject({ spaceOrigin: "isolated", spaceId: "space-4" });
  });
});

const oldEpisodeLeaseSchema = `CREATE TABLE episode_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  log_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  episode_id TEXT,
  creator_credential_id TEXT NOT NULL
)`;

function sqliteStorage(schema?: string): SqlStorage {
  const database = new DatabaseSync(":memory:");
  databases.add(database);
  if (schema) database.exec(schema);
  return new NodeSqlStorage(database);
}

function columnNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ readonly name: string }>("PRAGMA table_info(episode_lease)")
    .toArray()
    .map(({ name }) => name);
}

class NodeSqlStorage implements SqlStorage {
  constructor(private readonly database: DatabaseSync) {}

  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> {
    const statement = this.database.prepare(query);
    const values = bindings.map(sqlValue);
    const rows = /^(?:PRAGMA|SELECT|WITH)\b/iu.test(query.trimStart()) ? statement.all(...values) : (statement.run(...values), []);
    return {
      one: () => rows[0],
      toArray: () => rows,
    };
  }
}

function sqlValue(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new TypeError("Test SQL adapter only accepts scalar bindings.");
}
