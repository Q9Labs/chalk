import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_SET_V1 } from "./actions.js";
import { encodedEventSize, parseDiagnosticEventDraft } from "./events.js";
import { MAX_DIAGNOSTIC_EVENT_BYTES } from "./allowlists.js";
import { buildSemanticFixtureSet, buildVerificationLedger, HIGH_RISK_OPERATIONS, isRuntimeProofComplete, type SemanticFixtureSet, type VerificationLedger } from "./semantic-fixtures.js";

const fixturePath = resolve(new URL("../fixtures/semantic-events.v1.json", import.meta.url).pathname);
const ledgerPath = resolve(new URL("../fixtures/verification-ledger.v1.json", import.meta.url).pathname);
const fixtureSet = JSON.parse(readFileSync(fixturePath, "utf8")) as SemanticFixtureSet;
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as VerificationLedger;

const fixtureVariants = ["expectation", "success", "failure_or_gap"] as const;
const operationByName = new Map(ACTION_SET_V1.map((action) => [action.operation, action]));
const fixtureIdsFor = (operation: string, unsupported: boolean): readonly string[] => [`expectation.${operation}.v1`, unsupported ? "success.whiteboard.unsupported.v1" : `success.${operation}.v1`, unsupported ? "failure.whiteboard.unsupported.v1" : `failure.${operation}.v1`];

const forbiddenKeys = new Set(["body", "content", "message", "payload", "token", "secret", "password", "credential", "cookie", "exception", "stack", "sdp", "ice", "candidate", "address", "phone", "email", "webhook", "filename", "url", "uri"]);
const forbiddenValues = /(?:https?:\/\/|wss?:\/\/|bearer\s+[a-z0-9._~+\/-]+|-----begin|candidate:|v=0\r?\n|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i;

const assertNoRawContent = (value: unknown, path = "$"): void => {
  if (typeof value === "string") {
    expect(forbiddenValues.test(value), `${path} contains a raw or network value`).toBe(false);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawContent(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    expect(forbiddenKeys.has(key.toLowerCase()), `${path}.${key} is a content-bearing key`).toBe(false);
    assertNoRawContent(child, `${path}.${key}`);
  }
};

describe("Episode diagnostic semantic fixtures", () => {
  it("keeps generated fixture and ledger output deterministic", () => {
    expect(JSON.stringify(fixtureSet, null, 2)).toBe(JSON.stringify(buildSemanticFixtureSet(), null, 2));
    expect(JSON.stringify(ledger, null, 2)).toBe(JSON.stringify(buildVerificationLedger(), null, 2));
  });

  it("provides expectation, success, and failure/gap fixtures for every action", () => {
    const expectedIds = new Set(ACTION_SET_V1.flatMap((action) => fixtureIdsFor(action.operation, action.unsupported === true)));
    expect(Object.keys(fixtureSet.fixtures).sort()).toEqual([...expectedIds].sort());
    expect(Object.keys(fixtureSet.fixtures)).toHaveLength(252);

    for (const action of ACTION_SET_V1) {
      const actionFixtures = fixtureIdsFor(action.operation, action.unsupported === true).map((id) => fixtureSet.fixtures[id]);
      expect(actionFixtures.every((fixture) => fixture !== undefined)).toBe(true);
      for (const fixture of actionFixtures) {
        if (!fixture) continue;
        expect(fixture.operation).toBe(action.operation);
        expect(fixtureVariants).toContain(fixture.variant);
        expect(fixture.events.length).toBeGreaterThan(0);
        expect(fixture.checkpoints.map(({ key, class: checkpointClass, displayOrder, predicate }) => ({ key, class: checkpointClass, displayOrder, ...(predicate === undefined ? {} : { predicate }) }))).toEqual(action.checkpoints);
        for (const event of fixture.events) {
          const parsed = parseDiagnosticEventDraft(event);
          expect(parsed.name).toBe(action.operation);
          expect(encodedEventSize(parsed)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_EVENT_BYTES);
          expect(parsed.expectation?.name).toBe(`expectation.${action.operation}.v1`);
          expect(fixture.checkpoints.some((checkpoint) => checkpoint.key === parsed.expectation?.checkpoint && checkpoint.class === parsed.expectation?.checkpointClass)).toBe(true);
        }
      }
    }
  });

  it("carries a deadline and the catalog class into every expectation", () => {
    for (const fixture of Object.values(fixtureSet.fixtures)) {
      for (const checkpoint of fixture.checkpoints) {
        expect(Number.isFinite(Date.parse(checkpoint.deadlineAt))).toBe(true);
        expect(checkpoint.deadlineMilliseconds).toBeGreaterThan(0);
      }
      for (const event of fixture.events) {
        if (!event.expectation?.deadlineAt) continue;
        expect(Number.isFinite(Date.parse(event.expectation.deadlineAt))).toBe(true);
        expect(event.expectation.deadlineAt).toBe(fixture.checkpoints.find((checkpoint) => checkpoint.key === event.expectation?.checkpoint)?.deadlineAt);
      }
    }
  });

  it("keeps high-risk predicates semantic instead of generic", () => {
    for (const operation of HIGH_RISK_OPERATIONS) {
      const action = operationByName.get(operation);
      const fixture = fixtureSet.fixtures[`expectation.${operation}.v1`];
      expect(action).toBeDefined();
      expect(fixture).toBeDefined();
      if (!action || !fixture) continue;
      const keys = action.checkpoints.map((checkpoint) => checkpoint.key);
      expect(keys).not.toEqual(["intent", "terminal"]);
      expect(fixture.checkpoints.map((checkpoint) => checkpoint.key)).toEqual(keys);
    }
  });

  it("contains no raw content, credentials, or network identifiers", () => {
    assertNoRawContent(fixtureSet);
  });

  it("maps each action to its proof and all three fixture paths", () => {
    expect(ledger.status).toBe("pending");
    expect(ledger.fixtureStatus).toBe("pass");
    expect(ledger.runtimeStatus).toBe("pending");
    expect(ledger.entries).toHaveLength(ACTION_SET_V1.length);
    for (const entry of ledger.entries) {
      const action = operationByName.get(entry.operation);
      expect(action).toBeDefined();
      if (!action) continue;
      expect(entry.owner).toBe(action.owner);
      expect(entry.proofId).toBe(action.proofId);
      expect(entry.status).toBe("pending");
      expect(entry.fixtureStatus).toBe("pass");
      expect(entry.runtimeStatus).toBe("pending");
      expect(entry.proofCommand).toBe("");
      expect(entry.proofArtifact).toBe("");
      expect(isRuntimeProofComplete(entry)).toBe(false);
      for (const fixturePathValue of Object.values(entry.fixturePaths)) {
        const match = fixturePathValue.match(/#\/fixtures\/(.+)$/);
        expect(match).not.toBeNull();
        if (match) expect(fixtureSet.fixtures[match[1]]).toBeDefined();
      }
      expect(entry.unsupported).toBe(action.unsupported === true ? true : undefined);
    }
  });

  it("rejects an unproved runtime claim without command and artifact", () => {
    const pendingEntry = ledger.entries[0];
    expect(pendingEntry).toBeDefined();
    if (!pendingEntry) return;
    expect(isRuntimeProofComplete({ ...pendingEntry, runtimeStatus: "pass" })).toBe(false);
    expect(isRuntimeProofComplete({ ...pendingEntry, runtimeStatus: "pass", proofCommand: "pnpm proof", proofArtifact: "proof.json" })).toBe(true);
  });

  it("marks whiteboard as explicitly unsupported without pretending success", () => {
    const unsupportedFixtures = [fixtureSet.fixtures["expectation.whiteboard.unsupported.v1"], fixtureSet.fixtures["success.whiteboard.unsupported.v1"], fixtureSet.fixtures["failure.whiteboard.unsupported.v1"]];
    expect(unsupportedFixtures.every((fixture) => fixture?.unsupported === true)).toBe(true);
    for (const fixture of unsupportedFixtures) {
      expect(fixture?.events.length).toBeGreaterThan(0);
      for (const event of fixture?.events ?? []) {
        expect(event.phase).toBe("unsupported");
        expect(event.attributes?.reason).toBe("unsupported");
      }
    }
  });
});
