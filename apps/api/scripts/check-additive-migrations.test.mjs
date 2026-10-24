import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-additive-migrations.mjs", import.meta.url));
const migrations = "apps/api/db/migrations";
const approval = "-- chalk:removed-in #248";

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "chalk-migration-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "master");
  git("config", "user.name", "Migration test");
  git("config", "user.email", "migration-test@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, migrations), { recursive: true });
  const write = (name, sql) => writeFileSync(join(root, migrations, name), sql);
  write("001_existing.sql", "-- +goose Up\nDROP TABLE historical;\n");
  git("add", ".");
  git("commit", "-qm", "Existing migrations");
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  const run = (base = "origin/master") =>
    spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GATE_BASE_REF: base },
    });
  return { root, git, write, run };
}

test("CLI checks SQL in new Up sections only", (t) => {
  const repo = repository(t);
  const cases = [
    ["DROP TABLE spaces;", false],
    ["SELECT 1; -- +goose Down\nDROP TABLE spaces;", false],
    ["SELECT 1; -- chalk:removed-in #248\nDROP TABLE spaces;", false],
    ["ALTER TABLE spaces DROP COLUMN old;", false],
    ["ALTER TABLE spaces DROP old;", false],
    ["DROP TYPE old_type;", false],
    ["ALTER TABLE spaces DROP CONSTRAINT old;", false],
    ["ALTER TABLE spaces RENAME TO rooms;", false],
    ['ALTER TABLE spaces RENAME COLUMN "old" TO "new";', false],
    ['ALTER TABLE spaces ALTER COLUMN "count" TYPE bigint;', false],
    ["ALTER TABLE spaces ALTER count SET DATA TYPE bigint;", false],
    ["ALTER TABLE spaces ADD COLUMN title text;", true],
    ["CREATE FUNCTION example(int) RETURNS int LANGUAGE SQL AS $$ SELECT $1; $$;", true],
    ["CREATE TABLE spaces (id bigint);\n-- +goose Down\nDROP TABLE spaces;", true],
    ["-- DROP TABLE spaces;\n/* RENAME /* nested */ DROP */ SELECT 1;", true],
    ["SELECT 'DROP TABLE spaces;', \"rename\", 'it''s DROP';", true],
    ["DO $body$ BEGIN ALTER TABLE spaces DROP COLUMN old; END $body$;", false],
    [`${approval}\nALTER TABLE spaces DROP COLUMN old;`, true],
    [`-- chalk:removed-in\nDROP TABLE spaces;`, false],
    [`-- chalk:removed-in v0.0.85\nDROP TABLE spaces;`, false],
    [`-- chalk:removed-in #pr\nDROP TABLE spaces;`, false],
    [`/* ${approval} */\nDROP TABLE spaces;`, false],
    [`SELECT '${approval}';\nDROP TABLE spaces;`, false],
    [`DROP TABLE spaces;\n-- +goose Down\n${approval}`, false],
    [`DO $$ BEGIN\n${approval}\nDROP TABLE spaces; END $$;`, false],
    ["DO $$ BEGIN\n-- +goose Down\nDROP TABLE spaces; END $$;", false],
  ];
  for (const [sql, allowed] of cases) {
    repo.write("002_new.sql", `-- +goose Up\n${sql}\n`);
    repo.git("add", ".");
    const result = repo.run();
    assert.equal(result.status, allowed ? 0 : 1, `${sql}\n${result.stdout}${result.stderr}`);
    if (!allowed) assert.match(result.stderr, /002_new.sql: .*needs -- chalk:removed-in/);
  }
});

test("CLI uses merge base, ignores old migrations, and fails on a missing base", (t) => {
  const repo = repository(t);
  assert.equal(repo.run().status, 0, "master's historical DROP is exempt");
  repo.git("checkout", "-qb", "feature");
  repo.write("002_branch.sql", "-- +goose Up\nDROP TABLE spaces;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "New migration");
  repo.git("checkout", "-q", "master");
  repo.write("003_master.sql", "-- +goose Up\nSELECT 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "Master advances independently");
  repo.git("cherry-pick", "feature");
  repo.git("update-ref", "refs/remotes/origin/master", "HEAD");
  repo.git("checkout", "-q", "feature");
  // Master has the same migration, but the branch still added it since the merge base.
  const result = repo.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /002_branch.sql/);
  assert.equal(repo.run("missing-base").status, 1);
  const clone = join(repo.root, "shallow");
  repo.git("clone", "-q", "--depth", "1", "--branch", "feature", `file://${repo.root}`, clone);
  const shallow = spawnSync(process.execPath, [script], {
    cwd: clone,
    encoding: "utf8",
    env: { ...process.env, GATE_BASE_REF: "origin/master" },
  });
  assert.equal(shallow.status, 1);
  assert.match(shallow.stderr, /002_branch.sql: DROP/);
  assert.doesNotMatch(shallow.stderr, /Additive migration check failed/);
});

test("only the exact participant CHECK widening is exempt", (t) => {
  const repo = repository(t);
  const widening = "ALTER TABLE recording_capacity DROP CONSTRAINT recording_capacity_reserved_participants_check; ALTER TABLE recording_capacity ADD CONSTRAINT recording_capacity_reserved_participants_check CHECK (reserved_participants BETWEEN 0 AND 200);";
  for (const [sql, status] of [
    [widening, 0],
    [widening + " DROP TABLE spaces;", 1],
    [widening.replace("200", "99"), 1],
    [widening.replaceAll("reserved_participants", "reserved_episodes"), 1],
  ]) {
    repo.write("002_new.sql", `-- +goose Up\n${sql}\n`);
    repo.git("add", ".");
    const result = repo.run();
    assert.equal(result.status, status, result.stdout + result.stderr);
  }
});
