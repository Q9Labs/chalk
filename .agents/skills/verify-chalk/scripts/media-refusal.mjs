#!/usr/bin/env node
// Drives the "our media signalling refuses the join" journey: one browser joins through the seeded Space invite while
// every media signalling request is answered HTTP 400, the status the SFU gave listen-only joins in the 23 Nov incident.
// The failure screen must say the fault is ours and must not tell the person to switch networks.
//
//   node .agents/skills/verify-chalk/scripts/media-refusal.mjs <run-id> [--web <origin>]
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { webMediaFixture } from "../../../../scripts/web-proof/media.mjs";

const runId = process.argv[2];
if (!runId) throw new Error("usage: media-refusal.mjs <run-id> [--web <origin>]");
const out = join(".verify", runId);
const seed = JSON.parse(await readFile(".private/chalk-dev/seed.json", "utf8"));
const flag = process.argv.indexOf("--web");
const web = flag > 0 ? process.argv[flag + 1] : seed.urls.public;

await mkdir(join(out, "screenshots"), { recursive: true });
const steps = [];
const refused = [];
let browser;
let failure;
try {
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(webMediaFixture(1));
  await context.route("**/signal", (route) => {
    refused.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_request", message: "The request was refused", detail: "offer_section_unnamed" } }) });
  });
  const page = await context.newPage();
  await page.goto(new URL(seed.invite.path, web).href);
  await page.getByLabel("Your name", { exact: true }).fill("Verify A");
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  const ours = page.getByText("Something on our side failed", { exact: false });
  await ours.first().waitFor({ timeout: 60_000 });
  steps.push({ name: "the failure screen says the fault is ours", pass: true });
  await page.screenshot({ path: join(out, "screenshots", "refused-join.png") });
  const body = await page.locator("body").innerText();
  const blamesNetwork = /network may block|switch networks/i.test(body);
  steps.push({ name: "the failure screen does not blame the network", pass: !blamesNetwork, detail: blamesNetwork ? body.slice(0, 400) : undefined });
  steps.push({ name: "media signalling was actually refused", pass: refused.length > 0, detail: `${refused.length} refused request(s)` });
} catch (error) {
  failure = error;
  steps.push({ name: "journey", pass: false, detail: String(error.message ?? error).slice(0, 600) });
} finally {
  await browser?.close();
}
const pass = !failure && steps.every((entry) => entry.pass);
await writeFile(join(out, "result.json"), JSON.stringify({ journey: "media-refusal", pass, steps }, null, 2));
console.log(JSON.stringify({ journey: "media-refusal", pass, steps }, null, 2));
process.exit(pass ? 0 : 1);
