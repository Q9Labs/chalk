import assert from "node:assert/strict";
import test from "node:test";
import { newFindings } from "./verdict.mjs";

const frame = (name, findings, step = 0) => ({ frame: name, journey: "j", size: "phone", scheme: "dark", label: "opened", step, findings });
const clipped = { check: "child-clipped", key: "a > b", detail: "" };
const failed = { check: "journey-failed", key: "j@phone-dark", detail: "timeout" };

test("a finding the base has is not new", () => {
  assert.deepEqual(newFindings([frame("j@phone-dark.0", [clipped])], [frame("j@phone-dark.0", [clipped])]), []);
});

test("a finding the base lacks is new", () => {
  assert.equal(newFindings([frame("j@phone-dark.0", [clipped])], [frame("j@phone-dark.0", [])]).length, 1);
});

test("a journey that failed on the branch blocks even when it failed on the base too", () => {
  const result = newFindings([frame("j@phone-dark.error", [failed], -1)], [frame("j@phone-dark.error", [failed], -1)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].check, "journey-failed");
});

test("a branch frame has no baseline when its journey failed on the base, so it is not blamed", () => {
  assert.equal(newFindings([frame("j@phone-dark.0", [clipped])], [frame("j@phone-dark.error", [failed], -1)]).length, 0);
});
