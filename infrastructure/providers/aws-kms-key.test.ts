import assert from "node:assert/strict";
import { test } from "node:test";
import { keepRecordedPolicy } from "./aws-kms-key.ts";

const policy = (condition: object, actions: string[] = ["kms:Decrypt", "kms:DescribeKey"]) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "A", Effect: "Allow", Action: actions, Condition: condition }] });

test("a policy KMS reordered keeps the recorded text, so drift stays quiet", () => {
  const recorded = policy({ Null: { a: "false", b: "false" }, StringEquals: { c: "x" } });
  const live = { keyId: "k", policy: policy({ StringEquals: { c: "x" }, Null: { b: "false", a: "false" } }, ["kms:DescribeKey", "kms:Decrypt"]) };
  assert.deepEqual(keepRecordedPolicy(live, recorded), { keyId: "k", policy: recorded });
});

test("a policy that changed in meaning is still drift", () => {
  const recorded = policy({ StringEquals: { c: "x" } });
  const live = { keyId: "k", policy: policy({ StringEquals: { c: "y" } }) };
  assert.equal(keepRecordedPolicy(live, recorded), live);
  assert.equal(keepRecordedPolicy(live, undefined), live);
  assert.equal(keepRecordedPolicy(undefined, recorded), undefined);
});
