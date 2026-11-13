import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewScreens } from "./review.mjs";

// A stand-in `claude` on PATH: it records its arguments and token, then prints whatever the test put in reply.json.
const bin = mkdtempSync(join(tmpdir(), "ui-check-claude-"));
const claude = join(bin, "claude");
writeFileSync(
  claude,
  `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const reply = JSON.parse(readFileSync(${JSON.stringify(join(bin, "reply.json"))}, "utf8"));
writeFileSync(${JSON.stringify(join(bin, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), token: process.env.CLAUDE_CODE_OAUTH_TOKEN, apiKey: process.env.ANTHROPIC_API_KEY ?? null, cwd: process.cwd(), home: process.env.HOME, images: require("node:fs").readdirSync(process.cwd()) }));
if (reply.exit) { console.error(reply.stderr); process.exit(reply.exit); }
process.stdout.write(reply.stdout);
`,
);
chmodSync(claude, 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.ANTHROPIC_API_KEY = "must-not-reach-claude";

const dir = mkdtempSync(join(tmpdir(), "ui-check-review-"));
writeFileSync(join(dir, "chat@phone-dark.1.review.jpg"), "jpeg");
const screen = { frame: "chat@phone-dark.1", label: "after clicking Chat", size: "phone", scheme: "dark", fraction: 0.2, changed: 5000, regions: [{ x: 0, y: 400, w: 390, h: 200 }], afterWidth: 390, afterHeight: 844 };

const reply = (value) => writeFileSync(join(bin, "reply.json"), JSON.stringify(value));
const answer = (screens) => reply({ stdout: JSON.stringify({ type: "result", is_error: false, result: `\`\`\`json\n${JSON.stringify({ screens })}\n\`\`\`` }) });

test("nothing is sent when no screen changed enough", async () => {
  const result = await reviewScreens({ comparisons: [{ ...screen, fraction: 0 }], dir, token: "token" });
  assert.equal(result.status, "nothing-to-review");
});

test("without a token the review says it was skipped", async () => {
  const result = await reviewScreens({ comparisons: [screen], dir, token: undefined });
  assert.equal(result.status, "skipped-no-token");
  assert.equal(result.reviewed, 0);
});

test("the review runs Claude Opus 5.5 at high effort with only the Read tool and the subscription token", async () => {
  answer([{ frame: screen.frame, broken: false }]);
  const result = await reviewScreens({ comparisons: [screen], dir, token: "subscription-token" });
  assert.equal(result.status, "ok");
  const call = JSON.parse(readFileSync(join(bin, "call.json"), "utf8"));
  const after = (flag) => call.args[call.args.indexOf(flag) + 1];
  assert.equal(after("--model"), "claude-opus-5-5");
  assert.equal(after("--effort"), "high");
  assert.equal(after("--tools"), "Read");
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.match(after("-p"), /chat@phone-dark\.1\.review\.jpg/u);
  assert.equal(call.token, "subscription-token");
  assert.equal(call.apiKey, null);
});

test("the CLI runs in a fresh folder outside the checkout with an empty home and only the images", async () => {
  answer([{ frame: screen.frame, broken: false }]);
  await reviewScreens({ comparisons: [screen], dir, token: "token" });
  const call = JSON.parse(readFileSync(join(bin, "call.json"), "utf8"));
  assert.notEqual(call.cwd, process.cwd());
  assert.ok(!call.cwd.startsWith(process.cwd()));
  assert.equal(call.home, `${call.cwd}/home`.replace(/^\/private/u, ""));
  assert.deepEqual(call.images.sort(), ["chat@phone-dark.1.review.jpg", "home"]);
});

test("an answer that leaves a screen without a verdict is reported as not reviewed", async () => {
  for (const screens of [[], [{ frame: "other@phone-dark.0", broken: false }], [{ frame: screen.frame }]]) {
    answer(screens);
    const result = await reviewScreens({ comparisons: [screen], dir, token: "token" });
    assert.equal(result.status, "error-incomplete");
    assert.equal(result.reviewed, 0);
  }
});

test("a finding inside a changed region blocks", async () => {
  answer([{ frame: screen.frame, broken: true, finding: "The sheet covers the dock.", region: { x: 0, y: 0.5, w: 1, h: 0.2 } }]);
  const result = await reviewScreens({ comparisons: [screen], dir, token: "token" });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].blocking, true);
});

test("a finding outside every changed region does not block", async () => {
  answer([{ frame: screen.frame, broken: true, finding: "The header text is cut off.", region: { x: 0, y: 0, w: 1, h: 0.1 } }]);
  const result = await reviewScreens({ comparisons: [screen], dir, token: "token" });
  assert.equal(result.findings[0].blocking, false);
});

test("a finding with no region does not block", async () => {
  answer([{ frame: screen.frame, broken: true, finding: "Something looks off." }]);
  const result = await reviewScreens({ comparisons: [screen], dir, token: "token" });
  assert.equal(result.findings[0].blocking, false);
});

test("a failed Claude run is reported and blocks nothing", async () => {
  reply({ exit: 1, stderr: "Invalid API key" });
  const result = await reviewScreens({ comparisons: [screen], dir, token: "token" });
  assert.equal(result.status, "error-claude");
  assert.deepEqual(result.findings, []);
});

test("an error result from Claude is reported and blocks nothing", async () => {
  reply({ stdout: JSON.stringify({ type: "result", is_error: true, result: "Usage limit reached" }) });
  const result = await reviewScreens({ comparisons: [screen], dir, token: "token" });
  assert.equal(result.status, "error-claude");
  assert.deepEqual(result.findings, []);
});

test("an answer that is not JSON is reported and blocks nothing", async () => {
  reply({ stdout: JSON.stringify({ type: "result", is_error: false, result: "Looks fine to me." }) });
  const result = await reviewScreens({ comparisons: [screen], dir, token: "token" });
  assert.equal(result.status, "error-unparseable");
  assert.deepEqual(result.findings, []);
});
