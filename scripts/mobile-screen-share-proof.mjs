import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";

// Run with a disposable Android device containing the APK under test. No account or API key needed.
const serial = process.env.ADB_SERIAL;
if (!serial) throw new Error("Set ADB_SERIAL to the task-owned Android device");
const directory = process.env.CHALK_MOBILE_PROOF_DIRECTORY;
if (!directory) throw new Error("Set CHALK_MOBILE_PROOF_DIRECTORY to a private evidence directory");
await mkdir(directory, { recursive: true });
const requireSDK = createRequire(new URL("../sdks/typescript/client/package.json", import.meta.url));
const { chromium } = requireSDK("playwright");
const run = promisify(execFile);
const adb = (...args) => run("adb", ["-s", serial, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
const evidence = [];
const application = "ai.q9labs.chalk.mobile";
const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const deadline = setTimeout(() => browser.close(), 180_000);
const page = await browser.newPage({ reducedMotion: "reduce" });
page.on("requestfailed", (request) => evidence.push({ kind: "requestfailed", path: new URL(request.url()).pathname, error: request.failure() }));
page.on("response", (response) => {
  if (response.status() >= 400) evidence.push({ kind: "http-error", path: new URL(response.url()).pathname, status: response.status() });
});
await page.addInitScript(() => {
  window.proofPeers = [];
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args) {
      super(...args);
      window.proofPeers.push(this);
    }
  };
});

async function tree() {
  await adb("shell", "uiautomator", "dump", "/sdcard/chalk-screen-share-proof.xml");
  return (await adb("shell", "cat", "/sdcard/chalk-screen-share-proof.xml")).stdout;
}

async function find(label, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const xml = await tree();
    const nodes = xml.match(/<node\b[^>]*>/gu) ?? [];
    for (const node of nodes) {
      const name = node.match(/content-desc="([^"]*)"/u)?.[1];
      const text = node.match(/text="([^"]*)"/u)?.[1];
      const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u);
      if ((name === label || text === label) && bounds) return { x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2), y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2) };
    }
  }
  throw new Error(`Android control not found: ${label}`);
}

async function tap(label) {
  const point = await find(label);
  await adb("shell", "input", "tap", String(point.x), String(point.y));
}

async function shot(name) {
  const result = await run("adb", ["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(`${directory}/${name}.png`, result.stdout);
  await writeFile(`${directory}/${name}.xml`, await tree());
}

async function frames() {
  return page.evaluate(async () => {
    const rows = [];
    for (const peer of window.proofPeers) {
      for (const stat of (await peer.getStats()).values()) {
        if (stat.type === "inbound-rtp" && stat.kind === "video") rows.push({ id: stat.id, framesDecoded: stat.framesDecoded ?? 0 });
      }
    }
    return rows;
  });
}

try {
  await page.goto("https://chalkmeet.com/space");
  await page.getByLabel("Your name", { exact: true }).fill("Screen proof web");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await page.getByRole("button", { name: "Leave call", exact: true }).waitFor({ timeout: 45_000 });
  await adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", page.url(), "-p", application);
  await tap("Your name");
  await adb("shell", "input", "text", "Screen%snative%sguest");
  await tap("Join call");
  await tap("Turn off camera");
  await find("Turn on camera");
  await page.waitForTimeout(1500);
  const cameraStopped = await frames();
  await tap("More options");
  await shot("more");
  await tap("Share screen");
  await shot("consent");
  // Android 15/16 can offer a single app or the whole display. Choose the whole display.
  const consent = await tree();
  if (consent.includes('text="A single app"')) {
    await tap("A single app");
    await tap("Entire screen");
  }
  const ready = await tree();
  await tap(ready.includes('text="Start recording"') ? "Start recording" : "Start now");
  let before = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    before = await frames();
    if (before.some((row) => row.framesDecoded > (cameraStopped.find((prior) => prior.id === row.id)?.framesDecoded ?? 0) + 5)) break;
    await page.waitForTimeout(500);
  }
  assert.ok(
    before.some((row) => row.framesDecoded > (cameraStopped.find((prior) => prior.id === row.id)?.framesDecoded ?? 0) + 5),
    "Web guest received no native screen frames",
  );
  await tap("More options");
  await find("Stop sharing screen");
  await shot("sharing");
  const sharingServices = (await adb("shell", "dumpsys", "activity", "services", application)).stdout;
  await writeFile(`${directory}/sharing-service.txt`, sharingServices);
  assert.match(sharingServices, /ScreenCaptureService/u, "Projection foreground service is absent during capture");
  const after = await frames();
  assert.ok(
    after.some((row) => before.some((prior) => prior.id === row.id && row.framesDecoded > prior.framesDecoded + 2)),
    "Native screen frames stalled",
  );
  evidence.push({ kind: "native-screen-received", before, after });
  await page.screenshot({ path: `${directory}/receiving.png` });
  await tap("Stop sharing screen");
  await tap("More options");
  await find("Share screen");
  await shot("stopped");
  await page.waitForTimeout(1000);
  const stoppedBefore = await frames();
  await page.waitForTimeout(1000);
  const stoppedAfter = await frames();
  assert.ok(
    stoppedAfter.every((row) => stoppedBefore.some((prior) => prior.id === row.id && prior.framesDecoded === row.framesDecoded)),
    "Native screen kept sending after Stop sharing",
  );
  evidence.push({ kind: "native-screen-stopped", before: stoppedBefore, after: stoppedAfter });
  const stoppedServices = (await adb("shell", "dumpsys", "activity", "services", application)).stdout;
  await writeFile(`${directory}/stopped-service.txt`, stoppedServices);
  assert.doesNotMatch(stoppedServices, /ScreenCaptureService/u, "Projection foreground service leaked after Stop sharing");
  await page.screenshot({ path: `${directory}/receiver.png` });
  console.log("PASS native screen reached the web guest and stopped");
} catch (error) {
  await shot("failure").catch(() => undefined);
  evidence.push({ kind: "failure", message: error.message });
  throw error;
} finally {
  await adb("shell", "input", "keyevent", "KEYCODE_BACK").catch(() => undefined);
  await tap("Leave call").catch(() => undefined);
  await adb("shell", "am", "force-stop", application).catch(() => undefined);
  await adb("shell", "rm", "-f", "/sdcard/chalk-screen-share-proof.xml").catch(() => undefined);
  await page
    .getByRole("button", { name: "Leave call", exact: true })
    .click({ timeout: 2000 })
    .catch(() => undefined);
  clearTimeout(deadline);
  await browser.close();
  await writeFile(`${directory}/result.json`, JSON.stringify(evidence, null, 2));
}
