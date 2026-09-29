import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticTraceBriefSchema } from "@q9labsai/diagnostics";
import { DiagnosticInspectError } from "./errors.mjs";
import { buildTraceBrief, lookupTraceBrief } from "./trace-brief.mjs";

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
  assert.equal(brief.completeness, "partial");
  assert.equal(brief.events.length, 1);
  assert.equal(brief.serverSpans.length, 1);
  assert.equal(brief.errors.length, 1);
  assert.equal(brief.truncated, false);
  assert.ok(brief.visibilityGaps.some((gap) => gap.reason === "server_log_not_available"));
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
