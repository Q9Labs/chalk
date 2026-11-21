import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_TRACE = /^(?!0+$)[0-9a-f]{32}$/;
const HEX_SPAN = /^(?!0+$)[0-9a-f]{16}$/;
const BOUNDED_VALUE = /^[a-z][a-z0-9_]{0,63}$/;
const ATTRIBUTE_NAMES = new Set(["tenantId", "spaceId", "episodeId", "publicationId", "layerId", "outcome", "cause"]);
const OPENED = "screen_annotation.opened";
const CLOSED = "screen_annotation.closed";

const [probeFile, eventsFile] = process.argv.slice(2);
if (!probeFile) {
  process.stderr.write("Usage: node ledger.mjs <probe.json> [ledger.json]\nWithout ledger.json, psql reads the scoped journey using the local PG connection environment.\n");
  process.exit(2);
}
const probe = JSON.parse(readFileSync(probeFile, "utf8"));
assert.equal(probe.version, 1, "unsupported ledger proof");
for (const key of ["journeyId", "episodeId", "parentEventId", "layerId"]) assert.match(probe[key], UUID);
assert.ok(typeof probe.publicationId === "string" && probe.publicationId.length > 0 && probe.publicationId.length <= 256, "invalid publication fixture");
assert.ok(HEX_TRACE.test(probe.traceIds.open) && HEX_TRACE.test(probe.traceIds.close), "invalid expected trace IDs");

const ledger = JSON.parse(eventsFile === undefined ? readJourney(probe.journeyId) : readFileSync(eventsFile, "utf8"));
assert.ok(Array.isArray(ledger));
const events = ledger.filter((row) => row.name === OPENED || row.name === CLOSED);
assert.equal(events.length, 2, "expected exactly one open and one close after the retry and denials");
const [open, close] = events;
assert.equal(open.name, OPENED);
assert.equal(close.name, CLOSED);
assert.ok(Number.isSafeInteger(open.sequence) && Number.isSafeInteger(close.sequence) && close.sequence > open.sequence, "closure must follow opening in the journey");
const parent = ledger.find((row) => row.event_id === probe.parentEventId);
assert.ok(parent && parent.name !== OPENED && parent.name !== CLOSED, "no matching parent Episode or screen-publication event");
assert.equal(parent.journey_id, probe.journeyId);
assert.ok(parent.sequence < open.sequence, "parent must precede annotation");
for (const row of events) {
  assert.equal(row.journey_id, probe.journeyId);
  assert.equal(row.parent_event_id, row.name === OPENED ? probe.parentEventId : open.event_id);
  assert.equal(row.trace_id, row.name === OPENED ? probe.traceIds.open : probe.traceIds.close);
  assert.match(row.span_id, HEX_SPAN);
  assert.ok(
    Object.keys(row.attributes).every((key) => ATTRIBUTE_NAMES.has(key)),
    "annotation ledger contains an unexpected attribute",
  );
  const attrs = row.attributes;
  assert.equal(attrs.episodeId, probe.episodeId);
  assert.equal(attrs.layerId, probe.layerId);
  assert.equal(attrs.publicationId, probe.publicationId);
  assert.ok(attrs.outcome === undefined || BOUNDED_VALUE.test(attrs.outcome), "unbounded ledger outcome");
  assert.ok(attrs.cause === undefined || BOUNDED_VALUE.test(attrs.cause), "unbounded ledger cause");
}
assert.equal(close.attributes.cause, "episode_ended");

const { bind, retryBind, deniedBind, deniedWrite, episodeEnd } = probe.observations;
assert.equal(bind.result, "accepted");
assert.equal(bind.layerId, probe.layerId);
assert.ok(Number.isSafeInteger(bind.revision) && bind.revision > 0);
assert.equal(retryBind.result, "accepted");
assert.equal(retryBind.layerId, bind.layerId);
assert.equal(retryBind.revision, bind.revision);
assert.equal(deniedBind.result, "rejected");
assert.equal(deniedBind.layerId, null);
assert.equal(deniedWrite.result, "rejected");
assert.equal(deniedWrite.visibleRevision, bind.revision);
assert.equal(episodeEnd.layerId, null);

const { canaries, logs } = probe.redaction;
assert.ok(Array.isArray(canaries) && canaries.length >= 3 && canaries.every((value) => typeof value === "string" && value.length >= 8), "need distinct test canaries for mark text, bridge credential and invalid trace context");
assert.equal(new Set(canaries).size, canaries.length);
assert.ok(Array.isArray(logs) && logs.length > 0, "no captured telemetry for redaction");
const root = realpathSync(dirname(resolve(probeFile)));
const attached = probe.bridge.find((entry) => entry.outcome === "attached");
const rejected = probe.bridge.find((entry) => entry.outcome === "rejected");
for (const observation of [attached, rejected]) {
  assert.ok(observation && BOUNDED_VALUE.test(observation.method) && BOUNDED_VALUE.test(observation.cause), "need bounded attach acceptance and denial evidence");
  assert.ok(typeof observation.event === "string" && /^[a-z0-9_.]{1,100}$/.test(observation.event), "invalid attach event marker");
}
const telemetry = logs.flatMap((name) => {
  const text = readEvidence(root, name);
  assert.ok(
    canaries.every((value) => !text.includes(value)),
    "annotation telemetry exposed a test canary",
  );
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
});
assert.ok(
  canaries.every((value) => !JSON.stringify(events).includes(value)),
  "annotation ledger exposed a test canary",
);
for (const observation of [attached, rejected]) {
  assert.ok(
    telemetry.some((row) => row.event === observation.event && row.outcome === observation.outcome && row.method === observation.method && row.cause === observation.cause),
    "attach outcome did not appear in captured telemetry",
  );
}
process.stdout.write(`${JSON.stringify({ verdict: "pass", journeyId: probe.journeyId, open: open.event_id, close: close.event_id, closure: "episode_ended", ledgerRead: eventsFile === undefined ? "postgres" : "file", redaction: "pass", bridgeOutcomes: ["attached", "rejected"] }, null, 2)}\n`);

function readJourney(journeyId) {
  return execFileSync("psql", ["-X", "-Aqt", "-v", "ON_ERROR_STOP=1", "-v", `proof_journey=${journeyId}`], {
    encoding: "utf8",
    input: `
SELECT coalesce(json_agg(events ORDER BY sequence, occurred_at, event_id), '[]'::json)
FROM (
  SELECT event_id, journey_id, sequence, occurred_at, name, parent_event_id, trace_id, span_id, attributes
  FROM observability_journey_events WHERE journey_id = :'proof_journey'::uuid
) AS events;\n`,
  });
}

function readEvidence(root, path) {
  assert.equal(isAbsolute(path), false, "telemetry evidence path must be relative");
  const file = realpathSync(join(root, path));
  const fromRoot = relative(root, file);
  assert.ok(fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`), "telemetry evidence path escapes bundle");
  return readFileSync(file, "utf8");
}
