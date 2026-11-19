import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRules, replaceLifecycleRules, validateLifecycleRules } from "./r2-lifecycle.ts";
import { transcriptionLifecycleConfig } from "../cloudflare-r2-transcription-lifecycle/index.ts";

const input = { accountId: "a".repeat(32), bucketName: "test-transcripts" };

test("transcription rules preserve the 24-hour multipart and object cleanup contract", () => {
  const { rules, committedCleanupDeadlineHours } = transcriptionLifecycleConfig(input);
  assert.equal(committedCleanupDeadlineHours, 1);
  assert.deepEqual(
    rules.map((rule) => rule.id),
    ["expire-transcription-chunks", "expire-transcription-orphans"],
  );
  for (const rule of rules) {
    assert.equal(rule.enabled, true);
    assert.deepEqual(rule.deleteObjectsTransition.condition, { type: "Age", maxAge: 86400 });
    assert.deepEqual(rule.abortMultipartUploadsTransition.condition, { type: "Age", maxAge: 86400 });
    assert.deepEqual(rule.storageClassTransitions, []);
  }
});

test("configuration rejects invalid identity, deadlines and dangerous prefixes", () => {
  for (const override of [
    { accountId: "invalid" },
    { bucketName: "Bad Bucket" },
    { temporaryExpirationHours: 23 },
    { committedCleanupDeadlineHours: 0 },
    { committedCleanupDeadlineHours: 1.1 },
    { temporaryPrefixes: [] },
    { temporaryPrefixes: [""] },
    { temporaryPrefixes: ["/absolute/"] },
    { temporaryPrefixes: ["transcription/"] },
    { temporaryPrefixes: ["transcription/finalized/"] },
    { temporaryPrefixes: ["a/b/", "a-b/"] },
  ])
    assert.throws(() => transcriptionLifecycleConfig({ ...input, ...override }));
  assert.doesNotThrow(() => transcriptionLifecycleConfig({ ...input, committedCleanupDeadlineHours: 0.5 }));
});

test("updates and removal preserve unrelated lifecycle rules", () => {
  const { rules } = transcriptionLifecycleConfig(input);
  const unrelated = { id: "unrelated", enabled: false, conditions: { prefix: "other/" }, storageClassTransitions: [] };
  const current = [unrelated, ...rules];
  const ids = rules.map((rule) => rule.id);
  assert.deepEqual(replaceLifecycleRules(current, ids, []), [unrelated]);
  const unchanged = replaceLifecycleRules(current, ids, rules);
  assert.deepEqual(replaceLifecycleRules(unchanged, ids, rules), unchanged);
  const next = transcriptionLifecycleConfig({ ...input, temporaryPrefixes: ["next/"] }).rules;
  const updated = replaceLifecycleRules(current, [...ids, ...next.map((rule) => rule.id)], next);
  assert.deepEqual(
    updated.map((rule) => rule.id),
    ["expire-next", "unrelated"],
  );
});

test("lifecycle drift normalization preserves unrelated date and storage transitions", () => {
  const normalized = normalizeRules([
    { id: "archive", enabled: true, conditions: { prefix: "archive/" }, abortMultipartUploadsTransition: null, deleteObjectsTransition: { condition: { type: "Date", date: "2030-01-01" } }, storageClassTransitions: [{ condition: { type: "Age", maxAge: 3600 }, storageClass: "InfrequentAccess" }] },
  ]);
  assert.equal(normalized[0]?.storageClassTransitions?.[0]?.storageClass, "InfrequentAccess");
  assert.throws(() => normalizeRules([{ id: "future", enabled: true, conditions: { prefix: "" }, futureApiField: true }]));
  const { rules } = transcriptionLifecycleConfig(input);
  assert.throws(() =>
    validateLifecycleRules(
      rules.map((rule) => ({ ...rule, enabled: false })),
      "transcription/finalized/",
    ),
  );
});
