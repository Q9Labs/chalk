import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { declaredLatestVersion, latestMigrationVersion } from "./migration-latest-version.mjs";

test("latestMigrationVersion picks the highest numeric prefix", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "migrations-"));
  for (const name of ["20261001190000_a.sql", "20261001193000_b.sql", "embed.go"]) await writeFile(path.join(directory, name), "");
  assert.equal(await latestMigrationVersion(directory), "20261001193000");
});

test("latestMigrationVersion rejects a migration without a version prefix", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "migrations-"));
  await writeFile(path.join(directory, "oops.sql"), "");
  await assert.rejects(latestMigrationVersion(directory), /no numeric version prefix/);
});

test("declaredLatestVersion reads the Go constant", async () => {
  assert.equal(await declaredLatestVersion("package m\n\nconst LatestVersion int64 = 42\n"), "42");
  await assert.rejects(declaredLatestVersion("package m\n"), /LatestVersion/);
});
