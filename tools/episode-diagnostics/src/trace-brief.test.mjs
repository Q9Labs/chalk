import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticTraceBriefSchema, flowDefinitionSchema, checkFlowRun } from "@q9labsai/diagnostics";
import { readFileSync } from "node:fs";
import { DiagnosticInspectError } from "./errors.mjs";
import { buildTraceBrief, lookupFlowRun, lookupTraceBrief } from "./trace-brief.mjs";

const flow = flowDefinitionSchema.parse(JSON.parse(readFileSync(new URL("../../../diagnostics/flows.json", import.meta.url), "utf8"))[0]);
const semanticFixtures = JSON.parse(readFileSync(new URL("../../../packages/diagnostics-contracts/fixtures/semantic-events.v1.json", import.meta.url), "utf8")).fixtures;

const code = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";

function client({ error, events = [], operations = [] } = {}) {
  return {
    config: { environment: "localhost" },
    async resolveTrace() {
      if (error) throw new DiagnosticInspectError(error, error);
      return { body: { reference: "chalkdiag:v1:localhost:example" } };
    },
    async page(_reference, kind) {
      return { body: kind === "events" ? { events, hasMore: false } : { operations, hasMore: false } };
    },
  };
}

test("found trace maps retained events and spans without raw attributes", async () => {
  const events = [
    {
      cursor: 1,
      occurredAt: "2026-09-28T01:00:00Z",
      source: "api",
      name: "api.request",
      state: "failed",
      correlation: { traceId: code, spanId },
      attributes: { token: "private-value", url: "https://private.example/path" },
    },
  ];
  const operations = [
    {
      startedAt: "2026-09-28T01:00:00Z",
      source: "api",
      kind: "api.request",
      state: "failed",
      traceId: { idClass: "w3c.trace", value: code, copyable: true },
      spanId: { idClass: "w3c.span", value: spanId, copyable: true },
      durationMilliseconds: 12,
    },
  ];
  const brief = await lookupTraceBrief(code, "development", client({ events, operations }));
  assert.equal(brief.completeness, "complete");
  assert.equal(brief.events.length, 1);
  assert.equal(brief.serverSpans.length, 1);
  assert.equal(brief.errors.length, 1);
  assert.equal(brief.truncated, false);
  assert.deepEqual(brief.visibilityGaps, []);
  assert.ok(!JSON.stringify(brief).includes("private-value"));
  assert.ok(!JSON.stringify(brief).includes("private.example"));
  diagnosticTraceBriefSchema.parse(brief);
});

test("not found and expired are bounded empty briefs", async () => {
  for (const completeness of ["not_found", "expired"]) {
    const brief = await lookupTraceBrief(code, "development", client({ error: completeness }));
    assert.equal(brief.completeness, completeness);
    assert.deepEqual(brief.events, []);
    assert.deepEqual(brief.serverSpans, []);
    diagnosticTraceBriefSchema.parse(brief);
  }
});

test("missing span and unsafe event values are omitted with a visibility gap", () => {
  const brief = buildTraceBrief(
    code,
    "development",
    {
      events: [{ cursor: 2, occurredAt: "2026-09-28T01:00:00Z", source: "api", name: "api.request", state: "failed", correlation: { traceId: code }, attributes: { password: "secret" } }],
      hasMore: false,
    },
    { operations: [], hasMore: false },
  );
  assert.deepEqual(brief.events, []);
  assert.ok(brief.visibilityGaps.some((gap) => gap.reason === "not_observable"));
  assert.ok(!JSON.stringify(brief).includes("secret"));
});

test("retained event pages are bounded and marked truncated", () => {
  const events = Array.from({ length: 501 }, (_, index) => ({
    cursor: index + 1,
    occurredAt: "2026-09-28T01:00:00Z",
    source: "api",
    name: "api.request",
    state: "succeeded",
    correlation: { traceId: code, spanId },
  }));
  const brief = buildTraceBrief(code, "development", { events, hasMore: true }, { operations: [], hasMore: false });
  assert.equal(brief.events.length, 500);
  assert.equal(brief.truncated, true);
  diagnosticTraceBriefSchema.parse(brief);
});

test("an omitted error remains a named partial visibility gap", () => {
  const events = Array.from({ length: 101 }, (_, index) => ({
    cursor: index + 1,
    occurredAt: "2026-09-28T01:00:00Z",
    source: "api",
    name: "api.request",
    state: "failed",
    correlation: { traceId: code, spanId },
  }));
  const brief = buildTraceBrief(code, "development", { events, hasMore: false }, { operations: [], hasMore: false });
  assert.equal(brief.events.length, 101);
  assert.equal(brief.errors.length, 100);
  assert.equal(brief.completeness, "partial");
  assert.equal(brief.truncated, true);
  assert.ok(brief.visibilityGaps.some((gap) => gap.reason === "not_observable"));
});

test("failed operation without an event remains visible as a redacted error", () => {
  const brief = buildTraceBrief(
    code,
    "development",
    { events: [], hasMore: false },
    {
      operations: [{ startedAt: "2026-09-28T01:00:00Z", source: "api", kind: "api.request", state: "failed", traceId: code, spanId }],
      hasMore: false,
    },
  );
  assert.equal(brief.errors.length, 1);
  assert.equal(brief.errors[0].kind, "error");
  diagnosticTraceBriefSchema.parse(brief);
});

test("a mismatched target cannot use the configured operator credential", async () => {
  await assert.rejects(lookupTraceBrief(code, "production", client()), /target does not match/);
});

test("recording callback checkpoints retain flow run, step, and outcome without private attributes", () => {
  const raw = semanticFixtures["success.recording.provider.callback.v1"].events.map((event, index) => ({
    ...event,
    cursor: index + 1,
    diagnosticId: "episode_fixture_1",
    correlation: { traceId: code, spanId },
  }));
  const brief = buildTraceBrief(code, "development", { events: raw, hasMore: false }, { operations: [], hasMore: false });
  assert.deepEqual(
    brief.events.map((event) => event.attributes),
    flow.steps.map((step) => ({ flow: flow.id, flow_run: "episode_fixture_1", flow_step: step.id, outcome: "succeeded" })),
  );
  assert.equal(checkFlowRun(flow, brief.events, Date.parse("2026-08-04T01:05:06Z")).verdict, "ok");
  diagnosticTraceBriefSchema.parse(brief);
});

test("expectation intent events are not falsely reported as observed flow checkpoints", () => {
  const raw = semanticFixtures["expectation.recording.provider.callback.v1"].events.map((event, index) => ({ ...event, cursor: index + 1, correlation: { traceId: code, spanId } }));
  const brief = buildTraceBrief(code, "development", { events: raw, hasMore: false }, { operations: [], hasMore: false });
  assert.ok(brief.events.every((event) => event.attributes === undefined));
});

test("run lookup pages all retained episode events across traces with the operator client", async () => {
  const otherCode = "fedcba9876543210fedcba9876543210";
  const calls = [];
  const raw = semanticFixtures["success.recording.provider.callback.v1"].events.slice(0, 2).map((event, index) => ({
    ...event,
    cursor: index + 1,
    diagnosticId: "episode_fixture_1",
    correlation: { traceId: index ? otherCode : code, spanId },
  }));
  const ordinary = { ...raw[1], cursor: 3, eventId: "ordinary_event", name: "api.request", expectation: undefined, attributes: undefined };
  const diagnosticClient = {
    config: { environment: "localhost" },
    async page(reference, kind, query) {
      calls.push({ reference, kind, query });
      return { body: calls.length === 1 ? { events: [raw[0]], hasMore: true, nextCursor: 1 } : { events: [raw[1], ordinary], hasMore: false } };
    },
  };
  const result = await lookupFlowRun("episode_fixture_1", "development", diagnosticClient);
  assert.equal(result.events.length, 3);
  assert.deepEqual(
    result.events.map((event) => event.traceId),
    [code, otherCode, otherCode],
  );
  assert.deepEqual(result.events[2].attributes, { flow_run: "episode_fixture_1" });
  assert.ok(result.events.every((event) => event.attributes?.flow_run === "episode_fixture_1"));
  assert.equal(calls[0].reference, "chalkdiag:v1:localhost:episode_fixture_1");
  assert.equal(calls[1].query.afterCursor, 1);
  await assert.rejects(lookupFlowRun("episode_fixture_1", "production", diagnosticClient), /target does not match/);
});
