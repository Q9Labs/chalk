import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { reviewScreens } from "./review.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const dir = mkdtempSync(join(tmpdir(), "ui-check-review-"));
writeFileSync(join(dir, "chat@phone-dark.1.review.jpg"), "jpeg");
const screen = { frame: "chat@phone-dark.1", label: "after clicking Chat", size: "phone", scheme: "dark", fraction: 0.2, changed: 5000, regions: [{ x: 0, y: 400, w: 390, h: 200 }], afterWidth: 390, afterHeight: 844 };

const answer = (screens) => {
  globalThis.fetch = async () => Response.json({ content: [{ type: "text", text: JSON.stringify({ screens }) }], usage: { input_tokens: 1000, output_tokens: 100 } });
};

test("nothing is sent when no screen changed enough", async () => {
  const result = await reviewScreens({ comparisons: [{ ...screen, fraction: 0 }], dir, apiKey: "key" });
  assert.equal(result.status, "nothing-to-review");
});

test("without a key the review says it was skipped", async () => {
  const result = await reviewScreens({ comparisons: [screen], dir, apiKey: undefined });
  assert.equal(result.status, "skipped-no-key");
});

test("a finding inside a changed region blocks", async () => {
  answer([{ frame: screen.frame, broken: true, finding: "The sheet covers the dock.", region: { x: 0, y: 0.5, w: 1, h: 0.2 } }]);
  const result = await reviewScreens({ comparisons: [screen], dir, apiKey: "key" });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].blocking, true);
  assert.ok(result.cost > 0);
});

test("a finding outside every changed region does not block", async () => {
  answer([{ frame: screen.frame, broken: true, finding: "The header text is cut off.", region: { x: 0, y: 0, w: 1, h: 0.1 } }]);
  const result = await reviewScreens({ comparisons: [screen], dir, apiKey: "key" });
  assert.equal(result.findings[0].blocking, false);
});

test("a finding with no region does not block", async () => {
  answer([{ frame: screen.frame, broken: true, finding: "Something looks off." }]);
  const result = await reviewScreens({ comparisons: [screen], dir, apiKey: "key" });
  assert.equal(result.findings[0].blocking, false);
});

test("an API error is reported and blocks nothing", async () => {
  globalThis.fetch = async () => new Response("overloaded", { status: 529 });
  const result = await reviewScreens({ comparisons: [screen], dir, apiKey: "key" });
  assert.equal(result.status, "error-529");
  assert.deepEqual(result.findings, []);
});
