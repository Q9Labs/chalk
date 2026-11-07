#!/usr/bin/env node
// Drives the "join a call" journey: two browsers arrive through the seeded Space invite, publish fake camera and
// microphone, see each other's video advance, and leave. Evidence goes to <out>/ and the exit code is the verdict.
//
//   node .agents/skills/verify-chalk/scripts/join-call.mjs <run-id> [--web <origin>]
import { chromium } from "playwright";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { webMediaFixture } from "../../../../scripts/web-proof/media.mjs";
import { collectPage, measureFirstFrame, receiverTimedOut, senderNeverPublished, tileState } from "../../../../scripts/web-proof/tile-diagnostics.mjs";

const runId = process.argv[2];
if (!runId) throw new Error("usage: join-call.mjs <run-id> [--web <origin>]");
const out = join(".verify", runId);
const seed = JSON.parse(await readFile(".private/chalk-dev/seed.json", "utf8"));
const flag = process.argv.indexOf("--web");
const web = flag > 0 ? process.argv[flag + 1] : seed.urls.public;
const people = [
  { name: "Verify A", fixture: 1 },
  { name: "Verify B", fixture: 2 },
];

const waitMs = 60_000;
const enableMs = 15_000;
const steps = [];
const measurements = {};
const logs = { console: [], network: [] };
await mkdir(join(out, "screenshots"), { recursive: true });
await mkdir(join(out, "video"), { recursive: true });

async function step(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    steps.push({ name, pass: true, ms: Date.now() - started, detail });
  } catch (error) {
    steps.push({ name, pass: false, ms: Date.now() - started, detail: String(error.message ?? error).slice(0, 600) });
    throw error;
  }
}

async function apiGet(path) {
  const response = await fetch(new URL(path, web), { headers: { Authorization: `Bearer ${seed.systemToken}` } });
  if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
  return response.json();
}

let browser;
let failure;
const sessions = [];
try {
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  for (const person of people) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: join(out, "video"), size: { width: 1440, height: 960 } } });
    await context.addInitScript(webMediaFixture(person.fixture));
    const page = await context.newPage();
    page.on("console", (message) => logs.console.push({ who: person.name, type: message.type(), text: message.text().slice(0, 300), url: message.location().url.replace(/[?#].*/, "") }));
    page.on("pageerror", (error) => logs.console.push({ who: person.name, type: "pageerror", text: String(error.message).slice(0, 300) }));
    page.on("response", (response) => {
      const { pathname } = new URL(response.url());
      if (!pathname.startsWith("/v1/")) return;
      const entry = { who: person.name, method: response.request().method(), path: pathname, status: response.status() };
      logs.network.push(entry);
      if (entry.status >= 400)
        void response.json().then(
          (body) => {
            entry.errorCode = body?.error?.code;
          },
          () => undefined,
        );
    });
    page.on("requestfailed", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/v1/")) logs.network.push({ who: person.name, method: request.method(), path: pathname, error: request.failure()?.errorText });
    });
    sessions.push({ ...person, context, page });
  }

  for (const { name, page } of sessions) {
    await step(`${name} opens the seeded invite and joins`, async () => {
      await page.goto(new URL(seed.invite.path, web).href);
      await page.getByLabel("Your name", { exact: true }).fill(name);
      await page.screenshot({ path: join(out, "screenshots", `${name.replace(" ", "-")}-entrance.png`) });
      await page.getByRole("button", { name: "Join call", exact: true }).click();
      await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: 60_000 });
    });
  }

  for (const { name, page } of sessions) {
    await step(`${name} sees both tiles`, async () => {
      for (const other of people) await page.getByRole("button", { name: `Video tile for ${other.name}`, exact: true }).waitFor({ timeout: 60_000 });
    });
  }

  for (const { name, page } of sessions) {
    await step(`${name} turns on microphone and camera`, async () => {
      const controls = [
        ["Unmute microphone", "Mute microphone"],
        ["Turn on camera", "Turn off camera"],
      ];
      // Click both at once, as a person does: the first publish swaps a connection that never negotiated, and the second enable must survive that.
      await page.getByRole("region", { name: "Space stage", exact: true }).hover();
      for (const [control] of controls) await page.getByRole("button", { name: control, exact: true }).click();
      for (const [control, enabled] of controls) {
        // A dropped enable puts the button back to its off label with an error toast; say so here, not 60 s later as "never published".
        await page
          .getByRole("button", { name: enabled, exact: true })
          .waitFor({ timeout: enableMs })
          .catch(async () => {
            const toast = await page.locator('[data-part="toast"][data-type="error"]').evaluateAll((nodes) => nodes.map((node) => node.textContent));
            throw new Error(`clicking "${control}" did not produce "${enabled}" within ${enableMs / 1000} s; error toasts: ${toast.join(" | ") || "none"}`);
          });
      }
    });
  }

  // A receiver can only be judged once its sender shows its own picture.
  for (const { name, page } of sessions) {
    await step(`${name} publishes its own video`, async () => {
      const own = await measureFirstFrame(page, name, { timeoutMs: waitMs });
      measurements[name] = { ...measurements[name], ownFirstFrameMs: own.firstFrameMs };
      if (own.firstFrameMs === null) throw new Error(senderNeverPublished(name, own, waitMs));
      return { firstFrameMs: own.firstFrameMs };
    });
  }

  for (const { name, page } of sessions) {
    const other = people.find((person) => person.name !== name).name;
    await step(`${name} receives ${other}'s video through the SFU`, async () => {
      const received = await measureFirstFrame(page, other, { timeoutMs: waitMs });
      measurements[name] = { ...measurements[name], remoteFirstFrameMs: received.firstFrameMs };
      if (received.firstFrameMs === null) throw new Error(receiverTimedOut(name, other, received, waitMs));
      const first = received.state.frames;
      await page.waitForTimeout(3000);
      const { frames: second } = await page.evaluate(tileState, other);
      if (!(second > first + 5)) throw new Error(`${other}'s tile decoded ${first} then ${second} frames after ${received.firstFrameMs} ms; video is not advancing`);
      return { firstFrameMs: received.firstFrameMs, frames: [first, second] };
    });
  }

  for (const { name, page } of sessions) await page.screenshot({ path: join(out, "screenshots", `${name.replace(" ", "-")}-in-call.png`) });

  await step("the API records an Episode with both participants", async () => {
    const episodes = await apiGet(`/v1/tenants/${seed.tenantId}/spaces/${seed.spaceId}/episodes`);
    const live = (episodes.episodes ?? []).at(0);
    if (!live) throw new Error("the seeded Space has no Episode after both guests joined");
    const attendance = await apiGet(`/v1/tenants/${seed.tenantId}/spaces/${seed.spaceId}/episodes/${live.id}/attendance`);
    await writeFile(join(out, "attendance.json"), `${JSON.stringify(attendance, null, 2)}\n`);
    const names = JSON.stringify(attendance);
    for (const person of people) if (!names.includes(person.name)) throw new Error(`attendance does not list ${person.name}`);
    return { episode: live.id };
  });

  for (const { name, page } of sessions) {
    await step(`${name} leaves`, async () => {
      await page.getByRole("region", { name: "Space stage", exact: true }).hover();
      await page.getByRole("button", { name: "Leave call", exact: true }).click();
      await page.getByRole("button", { name: "Rejoin", exact: true }).waitFor({ timeout: 30_000 });
    });
  }
} catch (error) {
  failure = String(error.message ?? error);
  const pages = await Promise.all(sessions.map((session) => collectPage(session, { tileNames: people.map((person) => person.name), logs, measurements })));
  await writeFile(join(out, "diagnostics.json"), `${JSON.stringify({ failure, pages }, null, 2)}\n`);
  for (const { name, page } of sessions) await page.screenshot({ path: join(out, "screenshots", `${name.replace(" ", "-")}-failure.png`) }).catch(() => undefined);
} finally {
  for (const { context } of sessions) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}

// Evidence must never carry a credential: scan every file we wrote for the values this run was given.
const secrets = [seed.systemToken, process.env.CHALK_CLOUDFLARE_REALTIME_APP_SECRET, process.env.CHALK_CLOUDFLARE_REALTIME_APP_ID].filter(Boolean);
await writeFile(join(out, "console.json"), `${JSON.stringify(logs.console, null, 2)}\n`);
await writeFile(join(out, "network.json"), `${JSON.stringify(logs.network, null, 2)}\n`);
const result = { journey: "join-call", runId, web, pass: !failure && steps.every((entry) => entry.pass), failure, measurements, steps };
await writeFile(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
for (const entry of await readdir(out, { recursive: true })) {
  if (!/\.(json|log|txt)$/.test(entry)) continue;
  const text = await readFile(join(out, entry), "utf8");
  if (secrets.some((secret) => text.includes(secret))) {
    console.error(`evidence file ${entry} contains a credential`);
    process.exit(3);
  }
}
console.log(JSON.stringify({ pass: result.pass, failure, steps: steps.map((entry) => `${entry.pass ? "ok  " : "FAIL"} ${entry.name}`) }, null, 2));
process.exit(result.pass ? 0 : 1);
