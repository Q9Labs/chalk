// Usage: node livekit-room.mjs ; LiveKit arm of the SFU spike. Same room shape, taps, 1 Hz samples and report schema as
// scripts/dev/silence-repro.mjs, so silence-repro-analyze.mjs scores it unchanged. Runs inside the `cli` namespace.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const requireConsumer = createRequire(resolve(root, "tools/sdk-web-consumer-e2e/package.json"));
const { build } = requireConsumer("esbuild");
const { chromium } = requireConsumer("playwright");

// Same profiles as silence-repro.mjs (per direction: egress = client to SFU, ingress = SFU to client).
const profiles = {
  open: null,
  home: { egress: "delay 75ms 15ms loss 2%", ingress: "delay 75ms 15ms loss 2%" },
  mobile: { egress: "delay 150ms 30ms loss 8% rate 1mbit limit 100", ingress: "delay 150ms 30ms loss 8%" },
};
const conditions = (process.env.SR_CONDITIONS || "home").split(",");
const runsPerCell = Number(process.env.SR_RUNS || 1);
const runStart = Number(process.env.SR_RUN_START || 0);
const participantsCount = Number(process.env.SR_N || 8);
const speakerCount = Number(process.env.SR_SPEAKERS || 4);
const runSeconds = Number(process.env.SR_SECONDS || 105);
const url = process.env.LK_URL || "ws://10.1.0.1:7880";
const apiKey = process.env.LK_KEY || "devkey";
const apiSecret = process.env.LK_SECRET || "";
const output = resolve(process.env.SR_OUTPUT || "artifacts/silence-repro-livekit");
const control = process.env.SR_SHAPER_CONTROL;
const stats = process.env.SR_SHAPER_STATS;
assert.ok(apiSecret, "LK_SECRET");
await mkdir(output, { recursive: true });

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(room, identity) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: apiKey, sub: identity, nbf: now - 10, exp: now + 3600, name: identity, video: { room, roomJoin: true, canPublish: true, canSubscribe: true } });
  return `${head}.${body}.${createHmac("sha256", apiSecret).update(`${head}.${body}`).digest("base64url")}`;
}
const setProfile = (profile, dropPorts = []) => control && writeFileSync(control, JSON.stringify({ ...(profile ? { aToB: profile.egress, bToA: profile.ingress } : {}), dropPorts }));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const bundle = (
  await build({
    entryPoints: [resolve(import.meta.dirname, "livekit-page.js")],
    nodePaths: [process.env.LK_NODE_MODULES || "/data/workspace/lk-client/node_modules"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
  })
).outputFiles[0].text;
const http = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(`<html><body><script>${bundle}</script></body></html>`);
});
http.listen(4871, "127.0.0.1");
await once(http, "listening");

const report = { started: new Date().toISOString(), options: { runsPerCell, participantsCount, speakerCount, runSeconds }, runs: [] };
const save = () => writeFileSync(`${output}/silence-repro.json`, JSON.stringify(report));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SR_CHROMIUM || undefined,
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

async function runRoom(run, conditionName) {
  const condition = conditionName.split("+");
  const profile = profiles[condition.find((part) => Object.hasOwn(profiles, part)) ?? "open"];
  const firstUnmute = condition.includes("natural-idle") ? 20 : 3;
  const pubDrop = condition.includes("pubdrop");
  run.pubDrop = pubDrop;
  run.firstUnmuteSeconds = firstUnmute;
  const roomName = `sr-${Date.now().toString(36)}-${run.runIndex}`;
  const origin = Date.now();
  const contexts = [];
  try {
    setProfile(profile);
    const pages = await Promise.all(
      Array.from({ length: participantsCount }, async (_, index) => {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        await page.goto("http://127.0.0.1:4871/");
        await page.evaluate((cfg) => window.lkJoin(cfg), { url, token: token(roomName, `p${index}`), index });
        return page;
      }),
    );
    run.joinSeconds = (Date.now() - origin) / 1000;
    const start = performance.now();
    const schedule = [];
    for (let speaker = 0; speaker < speakerCount; speaker++) {
      schedule.push({ at: firstUnmute + speaker * 7, participant: speaker, kind: "unmute", first: true });
      if (!pubDrop) schedule.push({ at: 55 + speaker * 8, participant: speaker, kind: "mute" }, { at: 59 + speaker * 8, participant: speaker, kind: "unmute", first: false });
    }
    schedule.sort((a, b) => a.at - b.at);
    const chains = pages.map(() => Promise.resolve());
    const tap = async (event) => {
      event.t = (performance.now() - start) / 1000;
      event.clickedAtMs = Date.now() - origin;
      try {
        await pages[event.participant].evaluate((on) => window.lkMic(on), event.kind === "unmute");
        event.resolvedAfterMs = Math.round((performance.now() - start) / 1000 * 1000 - event.t * 1000);
      } catch (error) {
        event.error = error.message;
      }
    };
    let cursor = 0;
    let dropCursor = 0;
    const pubDrops = [0, 1, 2].map((speaker) => ({ at: 40 + speaker * 18, speaker }));
    while ((performance.now() - start) / 1000 < runSeconds) {
      const t = (performance.now() - start) / 1000;
      while (pubDrop && dropCursor < pubDrops.length && pubDrops[dropCursor].at <= t) {
        const drop = pubDrops[dropCursor++];
        void (async () => {
          const record = { speaker: drop.speaker, scheduledT: t };
          (run.pubDrops ??= []).push(record);
          try {
            record.ports = await pages[drop.speaker].evaluate(() => window.lkPorts());
            setProfile(profile, record.ports);
            record.startT = (performance.now() - start) / 1000;
            await sleep(5000);
          } catch (error) {
            record.error = error.message;
          } finally {
            setProfile(profile, []);
            record.endT = (performance.now() - start) / 1000;
          }
        })();
      }
      while (cursor < schedule.length && schedule[cursor].at <= t) {
        const action = schedule[cursor++];
        const event = { ...action, scheduledT: t };
        run.actions.push(event);
        chains[action.participant] = chains[action.participant].then(() => tap(event));
      }
      const states = await Promise.all(
        pages.map(async (page, listener) => {
          try {
            return { listener, ...(await page.evaluate(() => window.srSample())) };
          } catch (error) {
            return { listener, error: error.message, remote: [] };
          }
        }),
      );
      run.samples.push({ t: (performance.now() - start) / 1000, atMs: Date.now() - origin, cpu: null, states });
      const sleepStart = performance.now();
      await sleep(1000);
      const overrunMs = performance.now() - sleepStart - 1000;
      if (overrunMs > 3000) (run.stalls ??= []).push({ t: (sleepStart - start) / 1000, overrunMs: Math.round(overrunMs) });
    }
    await Promise.all(chains);
  } finally {
    if (profile && stats) run.shaped = JSON.parse(readFileSync(stats, "utf8"));
    setProfile(null);
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  }
}

try {
  for (let runIndex = runStart; runIndex < runStart + runsPerCell; runIndex++) {
    for (const conditionName of conditions) {
      const run = { build: "livekit", condition: conditionName, runIndex, started: new Date().toISOString(), network: [], actions: [], samples: [], faults: [], kills: [], listenerKills: [], injected503: [], harness: "livekit" };
      report.runs.push(run);
      try {
        await runRoom(run, conditionName);
      } catch (error) {
        run.error = error.message;
        console.log(`Run failed ${conditionName}/${runIndex}: ${error.message}`);
      }
      save();
      console.log(`Done livekit/${conditionName}/${runIndex}${run.error ? " (error)" : ""}`);
    }
  }
} finally {
  await browser.close();
  http.close();
}
