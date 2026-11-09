// Re-runs the nightly dress rehearsal's guests: the real web app, joined through the Space's public invite, with the rehearsal's
// synthetic capture (rehearsal-inject.js) and the peer-connection, request and Sync-frame diagnostics. Env: CHALK_PROOF_API_KEY,
// CHALK_PROOF_TENANT_ID, CHALK_PROOF_API_URL, CHALK_PROOF_WEB_URL; optional REPRO_GUESTS (3), REPRO_SECONDS (480),
// REPRO_FIRST_TOGGLE_S (200), REPRO_TOGGLE_EVERY_S (25), REPRO_GLARE ("1": guests 2 and 3 toggle the mic 0-500 ms apart),
// REPRO_OUT (output directory).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { installPcDiagnostics } from "./pc-diagnostics.mjs";

const { chromium } = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url))("playwright");
const env = (name, fallback) =>
  process.env[name] ??
  fallback ??
  (() => {
    throw new Error(`${name} is required`);
  })();
const API = env("CHALK_PROOF_API_URL");
const WEB = env("CHALK_PROOF_WEB_URL");
const tenant = `/v1/tenants/${env("CHALK_PROOF_TENANT_ID")}`;
const guestCount = Number(env("REPRO_GUESTS", "3"));
const seconds = Number(env("REPRO_SECONDS", "480"));
const firstToggle = Number(env("REPRO_FIRST_TOGGLE_S", "200"));
const every = Number(env("REPRO_TOGGLE_EVERY_S", "25"));
const glare = env("REPRO_GLARE", "0") === "1";
const out = env("REPRO_OUT", `/tmp/rehearsal-repro-${Date.now()}`);
mkdirSync(out, { recursive: true });
const inject = readFileSync(new URL("./rehearsal-inject.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const call = async (method, path, body) => {
  const response = await fetch(new URL(path, API), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("CHALK_PROOF_API_KEY")}`, Origin: WEB, "Idempotency-Key": randomUUID(), "X-Chalk-Media-Providers": "cloudflare_sfu,chalk_sfu", "User-Agent": "Chalk-Dress-Rehearsal/1.0" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} ${response.status}`);
  return text ? JSON.parse(text) : {};
};

const space = await call("POST", `${tenant}/spaces`, {
  name: `rehearsal-repro-${Date.now()}`,
  slug: `repro-${randomUUID()}`,
  media_plane: "chalk_sfu",
  recording_policy: "manual",
  transcription_policy: "on_demand",
  default_episode_duration_seconds: 1800,
  maximum_episode_duration_seconds: 1800,
  linger_window_seconds: 60,
  admission_policy: { mode: "open" },
  metadata: { rehearsal_repro: "1" },
});
const episode = await call("POST", `${tenant}/spaces/${space.id}/episodes`, { metadata: { rehearsal_repro: "1" } });
const invite = await call("PATCH", `${tenant}/spaces/${space.id}/public-invite`, { enabled: true });
const inviteURL = new URL(invite.canonical_url);
const joinURL = WEB + inviteURL.pathname + inviteURL.search + inviteURL.hash;
console.log(`Space ${space.id} plane ${space.media_plane} Episode ${episode.id}`);

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const startedAtMs = Date.now() + 1000;
const toggles = [];
const guests = [];

async function click(page, names) {
  for (const name of names) {
    const locator = page.locator(`button[aria-label="${name}"], button:text-is("${name}")`).first();
    if (!(await locator.count())) continue;
    try {
      await locator.click({ timeout: 4000 });
    } catch {
      await locator.evaluate((element) => element.click());
    }
    return name;
  }
  return null;
}
const MIC_OFF = ["Mute microphone"];
const MIC_ON = ["Unmute microphone"];
const CAM_OFF = ["Turn off camera", "Turn camera off", "Stop camera"];
const CAM_ON = ["Turn on camera", "Turn camera on", "Start camera"];

async function joinGuest(index) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(installPcDiagnostics);
  const page = await context.newPage();
  const name = `Repro ${index + 1}`;
  const events = [];
  page.on("pageerror", (error) => events.push({ t: Date.now(), k: "pageerror", message: String(error.message).slice(0, 200) }));
  page.on("console", (message) => message.type() === "error" && events.push({ t: Date.now(), k: "console_error", message: message.text().slice(0, 200) }));
  await page.goto(joinURL, { waitUntil: "load" });
  await page.evaluate(`(async()=>{${inject}})()`);
  await page.evaluate(`(async()=>{__rehearsal.name=${JSON.stringify(name)};__rehearsal.freq=${440 + index * 110};__rehearsal.hue=${index * 90};__rehearsal.start(5000);return 1})()`);
  await sleep(800);
  await page.getByLabel("Your name").fill(name);
  await click(page, ["Join call"]);
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(`(async()=>{return !!__rehearsal.find("Leave call")})()`)) break;
    await sleep(500);
  }
  await sleep(1500);
  await click(page, MIC_ON);
  await click(page, CAM_ON);
  events.push({ t: Date.now(), k: "joined" });
  return { page, context, events, diag: [] };
}

for (let index = 0; index < guestCount; index++) {
  guests.push(await joinGuest(index));
  await sleep(4000);
}
const startedAt = Date.now();
console.log(`All ${guestCount} guests joined; holding ${seconds}s`);

const drain = () => Promise.all(guests.map(async (guest) => guest.diag.push(...(await guest.page.evaluate(() => window.__pcDiag?.splice(0) ?? []).catch(() => [])))));
const sampling = (async () => {
  while (Date.now() - startedAt < seconds * 1000) {
    await sleep(5000);
    await drain();
  }
})();

async function toggle(guestIndex, kind) {
  const [offNames, onNames] = kind === "microphone" ? [MIC_OFF, MIC_ON] : [CAM_OFF, CAM_ON];
  const page = guests[guestIndex].page;
  const off = await click(page, offNames);
  toggles.push({ atMs: Date.now() - startedAt, guest: guestIndex, kind, enabled: false, ok: Boolean(off) });
  await sleep(6000);
  const on = await click(page, onNames);
  toggles.push({ atMs: Date.now() - startedAt, guest: guestIndex, kind, enabled: true, ok: Boolean(on) });
}
const toggling = (async () => {
  let cycle = 0;
  for (let at = firstToggle; at < seconds - 15; at += every, cycle++) {
    await sleep(Math.max(0, startedAt + at * 1000 - Date.now()));
    if (glare && guestCount >= 3) {
      await Promise.all([toggle(1, "microphone"), sleep(Math.floor(Math.random() * 500)).then(() => toggle(2, "microphone"))]);
    } else {
      await toggle(cycle % guestCount, cycle % 2 === 0 ? "microphone" : "camera");
    }
  }
})();
await Promise.all([sampling, toggling]);
await drain();
for (const guest of guests) guest.history = await guest.page.evaluate(() => ({ history: window.__rehearsal?.history ?? [], grants: window.__rehearsal?.grants ?? [] })).catch(() => ({}));
writeFileSync(`${out}/diagnostics.json`, JSON.stringify({ startedAtMs: startedAt, toggles, space: space.id, episode: episode.id, guests: guests.map((guest) => [...guest.diag, ...guest.events]), history: guests.map((guest) => guest.history) }));
console.log(`Saved ${out}/diagnostics.json`);
await call("POST", `${tenant}/spaces/${space.id}/episodes/${episode.id}/end`, {}).catch((error) => console.log(`end failed: ${error.message}`));
await call("POST", `${tenant}/spaces/${space.id}/archive`, {}).catch((error) => console.log(`archive failed: ${error.message}`));
for (const guest of guests) await guest.context.close();
await browser.close();
