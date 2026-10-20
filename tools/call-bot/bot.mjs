// Joins a Chalk Space as a test participant with Chrome's fake camera and tone,
// stays for HOLD_MINUTES, and records what it receives once a second.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { chromium } from "playwright";

const out = process.env.OUT ?? "../../artifacts";
const holdMinutes = Number(process.env.HOLD_MINUTES ?? 40);
const link = (await readFile(new URL("./link.txt", import.meta.url), "utf8")).trim();
await mkdir(`${out}/shots`, { recursive: true });
const log = (event) => appendFile(`${out}/timeline.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera", "microphone"] });
await context.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
});
const page = await context.newPage();
page.on("console", (m) => m.type() === "error" && log({ kind: "console-error", text: m.text().slice(0, 300) }));
page.on("pageerror", (e) => log({ kind: "page-error", text: String(e).slice(0, 300) }));

const opened = Date.now();
await page.goto(link, { waitUntil: "domcontentloaded" });
await page.getByPlaceholder("Enter your name", { exact: true }).fill("Claude (test bot)", { timeout: 60_000 });
const clicked = Date.now();
await page.getByRole("button", { name: "Enter Space", exact: true }).click({ timeout: 20_000 });
await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 60_000 });
const joined = Date.now();
const summary = { pageToEntranceMs: clicked - opened, enterToCallMs: joined - clicked, firstRemoteAudioAt: null, firstRemoteVideoAt: null };
await log({ kind: "joined", ...summary });
await page.screenshot({ path: `${out}/shots/joined.png` });

const sample = () =>
  page.evaluate(async () => {
    const inbound = [];
    for (const pc of window.__pcs) {
      if (pc.connectionState === "closed") continue;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === "inbound-rtp") inbound.push({ kind: s.kind, bytes: s.bytesReceived, frames: s.framesDecoded ?? null, level: s.audioLevel ?? null, jitterMs: s.jitter == null ? null : Math.round(s.jitter * 1000), lost: s.packetsLost });
      });
    }
    const tiles = [...document.querySelectorAll('[data-tour="video-grid"] *')].filter((el) => el.children.length === 0 && el.textContent.trim()).map((el) => el.textContent.trim()).slice(0, 20);
    return { pcs: window.__pcs.map((pc) => pc.connectionState), inbound, tiles };
  });

const until = joined + holdMinutes * 60_000;
let lastShot = 0;
while (Date.now() < until) {
  const s = await sample().catch((e) => ({ error: String(e).slice(0, 200) }));
  const audio = s.inbound?.find((x) => x.kind === "audio" && (x.level ?? 0) > 0.01);
  const video = s.inbound?.find((x) => x.kind === "video" && (x.frames ?? 0) > 0);
  if (audio && !summary.firstRemoteAudioAt) summary.firstRemoteAudioAt = new Date().toISOString();
  if (video && !summary.firstRemoteVideoAt) summary.firstRemoteVideoAt = new Date().toISOString();
  await log({ kind: "sample", ...s });
  if (Date.now() - lastShot > 60_000) {
    lastShot = Date.now();
    await page.screenshot({ path: `${out}/shots/${new Date().toISOString().replace(/[:.]/g, "-")}.png` }).catch(() => {});
  }
  await page.waitForTimeout(1000);
}

await page.getByRole("button", { name: "Leave", exact: true }).click({ timeout: 10_000 }).catch(() => {});
const dialog = page.getByRole("dialog");
if (await dialog.count()) await dialog.getByRole("button", { name: /^Leave/ }).click({ timeout: 10_000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/shots/left.png` }).catch(() => {});
await writeFile(`${out}/summary.json`, JSON.stringify(summary, null, 2));
await browser.close();
console.log(JSON.stringify(summary));
