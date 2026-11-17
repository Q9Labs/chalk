import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ROW_CAP } from "./axiom.mjs";
import { connectionEnv, episodeSql, readDatabase } from "./database.mjs";
import { diagnoseRows, strictCode, thresholds } from "./index.mjs";
import { assertEveryRowJoined, joinByIds, joinedShare, SOURCES } from "./join.mjs";
import { render } from "./render.mjs";
import { normalizeRow } from "./rows.mjs";
import { EPISODE, T0, at, fixture, neverConnectedCall, scenarios } from "./scenarios.mjs";
import { readSources } from "./sources.mjs";

const run = promisify(execFile);
const normalized = (rows) => rows.map((row) => normalizeRow(row));
const diagnose = (rows, gaps = []) => diagnoseRows(EPISODE, normalized(rows), gaps);

test("every source row of a call is reached by an id, and the output says how many were", () => {
  const f = fixture();
  const rows = normalized([
    ...scenarios["clean call"](),
    f.node(120, "sfu.subscription.paused", "viewer", "conn-view", { reason: "viewer" }),
    f.api(7, "http.failure", "viewer", { journey_id: "journey-9" }),
    { _time: at(7), _rowId: "fx-j", "service.name": null, service: { name: "chalk-api" }, attributes: { event: "media.track_close", journey_id: "journey-9" } },
  ]);
  const result = joinByIds(EPISODE, rows);
  assertEveryRowJoined(result);
  for (const source of SOURCES) assert.ok(joinedShare(result.stats[source]) === 1, source);
  assert.ok(result.stats.api.journey >= 1, "the API line without an Episode id joined by journey id");
  const text = render({ ...diagnoseRows(EPISODE, rows), elapsedMs: 1234 });
  assert.match(text, /^VERDICT: /mu);
  assert.match(text, /Rows by source: client \d+, api \d+, sync \d+, sfu \d+, recorder 0, db \d+/u);
  assert.match(text, /Elapsed: 1\.2 s$/u);
});

test("a source row that names no id fails the join check, and a row of another call is neither joined nor lost", () => {
  const f = fixture();
  const lost = normalizeRow(f.node(50, "sfu.subscription.layer", "viewer", undefined, { layer: "low", connection_id: undefined, episode_id: undefined, participant_id: undefined }));
  const other = normalizeRow(f.node(5, "sfu.session.registered", "viewer", "conn-other", { episode_id: "other-episode" }));
  const result = joinByIds(EPISODE, [...normalized(scenarios["clean call"]()), lost, other]);
  assert.equal(result.unjoined.length, 1);
  assert.throws(() => assertEveryRowJoined(result), /sfu:sfu\.subscription\.layer/u);
  assert.ok(!result.joined.some((row) => row.connection === "conn-other"));
});

test("the report shows a summary, a timeline per Participant with stage, side and row ids, and the missing data last", () => {
  const text = render({ ...diagnose(neverConnectedCall()), elapsedMs: 0 });
  const order = ["VERDICT:", "Summary", "Participant 153be25c (publisher)", "Participant 3c7e85ea (viewer)", "Missing data"].map((heading) => text.indexOf(heading));
  assert.ok(order.every((at) => at >= 0) && order.toSorted((a, b) => a - b).join() === order.join(), text);
  assert.match(text, /▶ 10:00:02 {2}connecting {2}unknown {2}had no media path.*\[fx-\d{4}, fx-\d{4}/u);
  assert.match(text, /\[blocks the verdict\] no API rows|no sdk\.call_stats rows/u);
});

/** The query bodies a fake Axiom received, and rows it answers with. */
function fakeAxiom(answer) {
  const queries = [];
  const fetchImpl = async (_url, { body }) => {
    const { apl } = JSON.parse(body);
    queries.push(apl);
    return { ok: true, status: 200, json: async () => ({ matches: answer(apl) }), text: async () => "" };
  };
  return { fetchImpl, queries };
}
const env = { AXIOM_TOKEN: "token", CHALK_LOG_DATASET: "logs", CHALK_TRACE_DATASET: "traces", AXIOM_ORG_ID: "org" };
const noDatabase = async () => ({ rows: [], gaps: [] });
const read = (overrides) => readSources({ episodeId: EPISODE, env, windowDays: 14, readDb: noDatabase, ...overrides });
const matchOf = (row) => ({ _time: row._time, _rowId: row._rowId, data: row });

test("a source that runs past the deadline is a blocking gap and the others are still read", async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const { rows, gaps } = await read({ fetchImpl: hang, deadlineMs: 50 });
  assert.deepEqual(rows, []);
  assert.match(gaps.map((gap) => gap.what).join("\n"), /log dataset could not be read \(the 0\.05 s deadline passed\)/u);
  assert.ok(gaps.every((gap) => gap.blocks || gap.source === "sync"));
});

test("a query that returns the row cap is a gap and not a silent cut", async () => {
  const flood = Array.from({ length: ROW_CAP }, (_, index) => matchOf({ _time: at(index % 60), _rowId: `flood-${index}`, attributes: { event: "sdk.call_stats", episode_id: EPISODE } }));
  const { fetchImpl } = fakeAxiom((apl) => (apl.includes("episode_id") ? flood : []));
  const { gaps } = await read({ fetchImpl });
  assert.ok(gaps.some((gap) => gap.blocks && /returned its row cap/u.test(gap.what)));
});

test("rows named by a connection id are looked up by connection_id and by provider_session_id, in chunks of at most 100", async () => {
  const rows = scenarios["clean call"]().filter((row) => row.attributes?.event === "sdk.call_stats");
  const { fetchImpl, queries } = fakeAxiom((apl) => (apl.includes("episode_id") ? rows.map(matchOf) : []));
  await read({ fetchImpl });
  const byConnection = queries.filter((apl) => apl.includes("provider_session_id"));
  assert.ok(byConnection.length > 0, "no query by provider_session_id");
  assert.ok(byConnection.every((apl) => apl.includes("connection_id") && (apl.match(/'conn-/gu) ?? []).length <= 100));
});

test("Sync is a visible blocking gap when the trace dataset is not set, and the database window is the one the thresholds name", async () => {
  const { fetchImpl } = fakeAxiom(() => []);
  const { gaps } = await read({ fetchImpl, env: { ...env, CHALK_TRACE_DATASET: undefined } });
  assert.ok(gaps.some((gap) => gap.source === "sync" && gap.blocks && /CHALK_TRACE_DATASET is not set/u.test(gap.what)));
  const windows = [];
  await read({ fetchImpl, now: T0, readDb: async ({ since }) => (windows.push(since), { rows: [], gaps: [] }) });
  assert.deepEqual(windows, [T0 - 14 * 86_400_000]);
  assert.match(episodeSql(EPISODE, T0 - 14 * 86_400_000), /created_at >= '2026-10-28T10:00:00\.000Z'::timestamptz/u);
});

test("the database URL reaches psql through its environment and never its arguments, and the session is read-only", async () => {
  const url = "postgresql://reader:s3cret-value@db.example.test:5432/chalk?sslmode=verify-full";
  const settings = connectionEnv(url, { PATH: "/usr/bin", HOME: "/home/x", AXIOM_TOKEN: "must-not-pass" });
  assert.deepEqual([settings.PGHOST, settings.PGUSER, settings.PGPASSWORD, settings.PGDATABASE, settings.PGSSLMODE], ["db.example.test", "reader", "s3cret-value", "chalk", "verify-full"]);
  assert.equal(settings.AXIOM_TOKEN, undefined);
  assert.match(settings.PGOPTIONS, /default_transaction_read_only=on/u);

  const directory = await mkdtemp(join(tmpdir(), "diagnose-call-"));
  await writeFile(join(directory, "psql"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${directory}/argv"\nprintf '%s\\n' '{"_rowId":"db:episodes:9feb0ff6","_time":"${at(0)}","event":"db.episode","episode_id":"${EPISODE}"}'\n`);
  await chmod(join(directory, "psql"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${directory}:${path}`;
  try {
    const result = await readDatabase({ url, episodeId: EPISODE, since: T0 - 86_400_000, signal: AbortSignal.timeout(10_000) });
    assert.equal(result.rows.length, 1);
  } finally {
    process.env.PATH = path;
  }
  const argv = await readFile(join(directory, "argv"), "utf8");
  assert.doesNotMatch(argv, /s3cret-value|db\.example\.test|postgresql:/u);
  const none = await readDatabase({ url: undefined, episodeId: EPISODE, since: T0 });
  assert.ok(none.gaps[0].blocks && /CHALK_DATABASE_URL is not set/u.test(none.gaps[0].what));
});

test("--strict fails on a bad call, then on missing evidence, and passes a clean call; the usage names every variable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "diagnose-call-"));
  const exit = async (name, ...flags) => {
    const file = join(directory, `${name.replaceAll(" ", "-")}.json`);
    await writeFile(file, JSON.stringify(scenarios[name]()));
    return run("node", [new URL("./index.mjs", import.meta.url).pathname, EPISODE, "--fixture", file, ...flags]).then(
      () => 0,
      (error) => error.code,
    );
  };
  assert.equal(await exit("never connected with peer states", "--strict"), 3);
  assert.equal(await exit("missing sources", "--strict"), 2);
  assert.equal(await exit("clean call", "--strict"), 0);
  assert.equal(await exit("never connected with peer states"), 0);
  const usage = await run("node", [new URL("./index.mjs", import.meta.url).pathname]).catch((error) => error);
  assert.equal(usage.code, 64);
  for (const name of ["AXIOM_TOKEN", "AXIOM_ORG_ID", "CHALK_LOG_DATASET", "CHALK_TRACE_DATASET", "CHALK_DATABASE_URL"]) assert.match(usage.stderr, new RegExp(name, "u"));
  assert.equal(strictCode({ findings: [], gaps: [{ blocks: false }] }), 0);
});

test("the fixtures hold no production identifier: every id is invented", () => {
  const text = JSON.stringify(Object.values(scenarios).map((build) => build()));
  assert.doesNotMatch(text, /52730039|479a5f5e|688d874b|6b0f58f2|ff75a37c|3a47f23d-[0-9a-f]{4}/u);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-(?!444455556666|000000000001)[0-9a-f]{12}/u);
});

test("the checker reads the same thresholds the file names, with no dead setting", () => {
  assert.deepEqual(Object.keys(thresholds).toSorted(), ["available_floor_kbps", "early_replacement_ms", "healthy_loss_pct", "healthy_rtt_ms", "leave_slack_ms", "silence_ms", "starved_floor_kbps", "starved_ms", "window_days"]);
});
