// @ts-check
/**
 * Runs one Slice 1 fault scenario on real Postgres: applies the spec's seed, reads the db-source rows back with psql,
 * merges them with the emitted rows the spec declares, judges the fixture with the catalogue's check, and in write mode
 * hands the rows to the chain under observability/fixtures/<code>/chain/. CHALK_CHAIN_WRITE=1 rewrites the hand-off
 * files; without it the test only judges, so the committed chain is what the coverage gate replays.
 *
 * pg rows come from real Postgres: `scripts/gates/with-postgres.sh -- node --test <fault.test>` gives CHALK_DATABASE_URL
 * on an isolated database. A spec with pg fails without it — a hand-written db row is not evidence.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGUE } from "../diagnose-call/proof/catalogue.mjs";
import { judgeFixture, ruleResult } from "../diagnose-call/proof/rows.mjs";
import { SPECS } from "./specs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** PG* env for a read-write session; the password stays in env, never on the command line. @param {string} url */
function pgEnv(url) {
  const parsed = new URL(url);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name === "PATH" || name === "HOME" || name === "LANG" || name === "LC_ALL" || name.startsWith("PG"))),
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: parsed.pathname.slice(1),
    PGOPTIONS: "-c statement_timeout=20000",
  };
}

/** @param {string} url @param {string} sql */
function psql(url, sql) {
  return execFileSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: pgEnv(url), encoding: "utf8" });
}

/**
 * The spec's db-source rows, read from real Postgres. Each SELECT row is a JSON object in envelope shape.
 * @param {{ seed: string, select: string }} pg
 */
function postgresRows(pg) {
  const url = process.env.CHALK_DATABASE_URL;
  if (!url) throw new Error("this scenario's witnesses are Postgres rows: run it under scripts/gates/with-postgres.sh or set CHALK_DATABASE_URL");
  // Seed, read and roll back in one transaction: the rows are real Postgres reads, and nothing persists between variants.
  const out = psql(url, `begin;\n${pg.seed}\n${pg.select};\nrollback;`).trim();
  if (out === "") return [];
  return out
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

/**
 * @param {string} code
 * @param {"positive" | "healthy"} variant
 */
export function rowsFor(code, variant) {
  const spec = SPECS[code];
  const pg = variant === "healthy" ? (spec.healthy_pg ?? spec.pg) : spec.pg;
  const staticRows = spec[variant].rows.map((row) => ({ ...row }));
  const pgRows = pg ? postgresRows(pg) : [];
  const rows = [...staticRows, ...pgRows];
  // Subject ids a row omits name the item it belongs to: the attempt's client session stays in its rows, while an
  // Episode row that says nothing of its episode is read as the item's own. Tenant and environment always fill in.
  const declaration = /** @type {{ tenant: string | null, kind: string, id: string }} */ (spec.declaration);
  return rows.map((row) => {
    const out = { ...row };
    if (declaration.tenant !== null && out.tenant_id === undefined) out.tenant_id = declaration.tenant;
    if (declaration.kind === "platform" && out.env === undefined) out.env = declaration.id;
    if (declaration.kind === "episode" && out.episode_id === undefined) out.episode_id = declaration.id;
    if (declaration.kind === "attempt" && out.client_session_id === undefined) out.client_session_id = declaration.id;
    return out;
  });
}

/** @param {string} code @param {"positive" | "healthy"} variant @param {object[]} rows */
export function fixtureFor(code, variant, rows) {
  const spec = SPECS[code];
  return {
    description: spec.description,
    asof_ms: spec.asof_ms,
    declaration: spec.declaration,
    rows,
    chain: [`observability/fixtures/${code}/chain/${code}.rows.${variant}.json`],
  };
}

/**
 * Judges one variant: positive must produce the expected finding code/hop/outcome; healthy must produce none and prove
 * every eligible subject checked. Prints the C4 line the proof log cites.
 * @param {string} code @param {"positive" | "healthy"} variant @param {object[]} rows
 */
export function judge(code, variant, rows) {
  const spec = SPECS[code];
  const { verdict, dropped } = judgeFixture({ description: spec.description, asof_ms: spec.asof_ms, declaration: spec.declaration, rows }, CATALOGUE, code);
  assert.deepEqual(dropped, [], `rows dropped: ${JSON.stringify(dropped)}`);
  const result = ruleResult(verdict, code);
  const findings = verdict.findings.filter((f) => f.code === code);
  for (const f of findings) console.log(`${code} ${variant} ${f.outcome} item=${spec.declaration.kind}:${spec.declaration.id} hop=${f.hop} module=${f.module} reason=${f.reason ?? "-"} observed=${JSON.stringify(f.observed)}`);
  if (variant === "positive") {
    assert.equal(findings.length, 1, `expected exactly one ${code} finding, got ${JSON.stringify(verdict.findings.map((f) => f.code))} coverage=${JSON.stringify(verdict.coverage.by_code)}`);
    const finding = findings[0];
    assert.equal(finding.outcome, spec.expect.outcome, `outcome`);
    assert.equal(finding.hop, spec.expect.hop, `hop`);
  } else {
    assert.equal(findings.length, 0, `healthy control must give no ${code} finding, got ${JSON.stringify(findings)}`);
    assert.ok(result.eligible > 0, "healthy control checked no subject");
    assert.equal(result.checked, result.eligible, `checked ${result.checked} of ${result.eligible}`);
  }
  return verdict;
}

/** The fault-scenario body every <code>.fault.test.mjs wraps. @param {string} code */
export function runScenario(code) {
  for (const variant of /** @type {const} */ (["positive", "healthy"])) {
    const rows = rowsFor(code, variant);
    const verdict = judge(code, variant, rows);
    if (process.env.CHALK_CHAIN_WRITE === "1") {
      const file = join(root, `observability/fixtures/${code}/chain/${code}.rows.${variant}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(rows, null, 1)}\n`);
      console.log(`wrote ${file}`);
    }
    if (variant === "positive") console.log(`${code} verdict ${verdict.outcome} findings=${verdict.findings.length}`);
  }
}

/** The hop-b body: writes positive.json and healthy.json from the committed chain rows, and re-judges them. @param {string} code */
export function runChain(code) {
  for (const variant of /** @type {const} */ (["positive", "healthy"])) {
    const chainPath = `observability/fixtures/${code}/chain/${code}.rows.${variant}.json`;
    const rows = JSON.parse(readFileSync(join(root, chainPath), "utf8"));
    const fixture = fixtureFor(code, variant, rows);
    judge(code, variant, fixture.rows);
    if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(join(root, `observability/fixtures/${code}/${variant}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
  }
}
