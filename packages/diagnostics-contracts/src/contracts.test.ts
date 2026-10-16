import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTION_SET_V1, ALLOWLISTED_ATTRIBUTE_KEYS, MAX_DIAGNOSTIC_EVENT_BYTES, SAFE_ID_CLASSES, acceptDiagnosticEvent, actionStatus, encodedEventSize, parseDiagnosticEventDraft, redactDiagnosticAttributes, validateDiagnosticEventDraft, validateActionCoverage } from "./index.js";
import type { DiagnosticEventDraft } from "./index.js";

const event = (): DiagnosticEventDraft => ({
  version: 1,
  eventId: "event01",
  producerSequence: 1,
  occurredAt: "2026-08-04T00:00:00.000Z",
  source: "sdk",
  name: "chat.send",
  phase: "intent",
  state: "started",
  attributes: { status: "accepted", retryable: false },
});

describe("DiagnosticEvent/v1", () => {
  it("accepts a safe event and keeps it below the encoded limit", () => {
    const parsed = parseDiagnosticEventDraft(event());
    expect(parsed.version).toBe(1);
    expect(encodedEventSize(parsed)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_EVENT_BYTES);
    expect(acceptDiagnosticEvent(parsed, { diagnosticId: "diag01", cursor: 1, receivedAt: "2026-08-04T00:00:01.000Z" }).fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects unknown action roots and forbidden attributes", () => {
    expect(validateDiagnosticEventDraft({ ...event(), name: "made_up.action" }).ok).toBe(false);
    expect(validateDiagnosticEventDraft({ ...event(), attributes: { message: "chat" } }).ok).toBe(false);
  });

  it("rejects an event over 2 KiB", () => {
    const oversized = { ...event(), attributes: { reason: "x".repeat(256) } };
    expect(validateDiagnosticEventDraft(oversized).ok).toBe(true);
    expect(
      validateDiagnosticEventDraft({
        ...oversized,
        attributes: { reason: "x".repeat(256), result: "y".repeat(256), status: "z".repeat(256), kind: "k".repeat(256), transport: "t".repeat(256), visibility: "v".repeat(256), object_ref_class: "o".repeat(256), attachment_type: "a".repeat(256), size_bucket: "s".repeat(256) },
      }).ok,
    ).toBe(false);
  });
});

describe("references and action coverage", () => {
  it("keeps the machine Safe ID registry identical to the runtime allowlist", () => {
    const registry = JSON.parse(readFileSync(new URL("../safe-id-classes.v1.json", import.meta.url), "utf8")) as { classes: { idClass: string; storage: string; copyable: boolean; maxLength: number; alphabet: string }[] };
    expect(Object.fromEntries(registry.classes.map(({ idClass, ...rule }) => [idClass, rule]))).toEqual(SAFE_ID_CLASSES);
  });

  it("keeps published schemas and action catalog in sync with runtime contracts", () => {
    const schema: { properties: { attributes: { patternProperties: { [pattern: string]: unknown } } }; "x-attribute-allowlist": string[] } = JSON.parse(readFileSync(new URL("../diagnostic-event.v1.schema.json", import.meta.url), "utf8"));
    const catalog: { groups: { root: string; actions: string[] }[] } = JSON.parse(readFileSync(new URL("../episode-diagnostic-actions.v1.json", import.meta.url), "utf8"));
    expect(schema["x-attribute-allowlist"]).toEqual(ALLOWLISTED_ATTRIBUTE_KEYS);
    const patterns = Object.keys(schema.properties.attributes.patternProperties).map((pattern) => new RegExp(pattern));
    for (const key of ALLOWLISTED_ATTRIBUTE_KEYS) expect(patterns.some((pattern) => pattern.test(key))).toBe(true);
    expect(catalog.groups.flatMap((group) => group.actions.map((action) => `${group.root}.${action}`))).toEqual(ACTION_SET_V1.map((action) => action.operation));
  });

  it("covers whiteboard lifecycle and closes every action", () => {
    expect(validateActionCoverage().complete).toBe(true);
    expect(actionStatus("whiteboard.connect")).toBe("supported");
    expect(actionStatus("whiteboard.recover")).toBe("supported");
    expect(actionStatus("whiteboard.disconnect")).toBe("supported");
    expect(ACTION_SET_V1.length).toBe(87);
  });
});

describe("redaction and parity", () => {
  it("removes content and credentials while preserving safe metadata", () => {
    const redacted = redactDiagnosticAttributes({ status: "committed", bytes: 4, message: "secret", token: "Bearer x" });
    expect(redacted.attributes).toEqual({ status: "committed", bytes: 4 });
    expect(redacted.redactedKeys).toEqual(expect.arrayContaining(["message", "token"]));
  });
});
