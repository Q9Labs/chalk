#!/usr/bin/env node
// Counts the Sync WebSocket upgrades one browser tab makes across lobby, join, leave and a second call, so a change to
// socket reuse shows as numbers: an upgrade before each Join press means the join dialed none of its own.
//
//   node .agents/skills/verify-chalk/scripts/socket-reuse.mjs <run-id> [--web <origin>] [--lobby-ms 8000] [--leave-ms 3000]
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { webMediaFixture } from "../../../../scripts/web-proof/media.mjs";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const runId = process.argv[2];
if (!runId) throw new Error("usage: socket-reuse.mjs <run-id> [--web <origin>] [--lobby-ms N] [--leave-ms N]");
const seed = JSON.parse(await readFile(".private/chalk-dev/seed.json", "utf8"));
const web = arg("--web", seed.urls.public);
const lobbyMs = Number(arg("--lobby-ms", "8000"));
const leaveMs = Number(arg("--leave-ms", "3000"));
const out = join(".verify", runId);
// A fresh name per run, so a participant a previous run left behind cannot add a second tile.
const name = `Probe ${Date.now().toString(36)}`;
await mkdir(join(out, "screenshots"), { recursive: true });

const started = Date.now();
const timeline = [];
const sockets = [];
const mark = (event) => timeline.push({ at: Date.now() - started, event });

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript(webMediaFixture(1));
const page = await context.newPage();
page.on("websocket", (socket) => {
  if (!new URL(socket.url()).pathname.endsWith("/v1/sync")) return;
  const id = sockets.length + 1;
  const record = { id, opened: Date.now() - started, closed: null };
  sockets.push(record);
  mark(`sync socket #${id} opened`);
  socket.on("close", () => {
    record.closed = Date.now() - started;
    mark(`sync socket #${id} closed`);
  });
});

let failure;
const shot = (name) => page.screenshot({ path: join(out, "screenshots", `${name}.png`) });
const joins = [];
const call = async (label) => {
  await page
    .getByRole("button", { name: "Join call", exact: true })
    .or(page.getByRole("button", { name: "Rejoin", exact: true }))
    .click();
  const pressedAt = Date.now() - started;
  const before = sockets.length;
  mark(`${label}: Join pressed`);
  await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: 60_000 });
  mark(`${label}: in the call`);
  // Upgrades the join itself started: sockets opened after the press. Zero means the join used a socket that was already open.
  joins.push({ label, pressedAt, inCallAt: Date.now() - started, upgradesAfterPress: sockets.length - before });
};
try {
  await page.goto(new URL(seed.invite.path, web).href);
  await page.getByLabel("Your name", { exact: true }).fill(name);
  mark("lobby ready, name typed");
  await shot("1-lobby");
  await page.waitForTimeout(lobbyMs);
  await call("first call");
  await shot("2-first-call");
  await page.getByRole("region", { name: "Space stage", exact: true }).hover();
  await page.getByRole("button", { name: "Leave call", exact: true }).click();
  await page.getByRole("button", { name: "Rejoin", exact: true }).waitFor({ timeout: 30_000 });
  mark("left");
  await shot("3-left");
  await page.waitForTimeout(leaveMs);
  await call("second call");
  await shot("4-second-call");
} catch (error) {
  failure = String(error.message ?? error);
  await shot("failure").catch(() => undefined);
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

const result = { journey: "socket-reuse", runId, web, lobbyMs, leaveMs, pass: !failure, failure, syncSocketsOpened: sockets.length, joins, sockets, timeline };
await writeFile(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
for (const row of timeline) console.log(`${String(row.at).padStart(6)} ms  ${row.event}`);
for (const join of joins) console.log(`${join.label}: ${join.upgradesAfterPress} upgrades after the press, in the call ${join.inCallAt - join.pressedAt} ms after it`);
console.log(`sync sockets opened: ${sockets.length}${failure ? `\nFAILED: ${failure}` : ""}`);
process.exit(failure ? 1 : 0);
