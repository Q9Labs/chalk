#!/usr/bin/env node
// Several classes that start at the same moment on one media provider, each a real call of SDK clients in
// headless Chromium with generated camera and tones.
//
//   CHALK_PROOF_MEDIA_PLANE=chalk_sfu node scripts/prod-proof/sfu-classes.mjs [--classes 6] [--guests 3] [--hold-seconds 60]
//
// Every class creates its Space and Episode and launches its guests together with the others. A guest whose
// media grant is not on the chosen provider fails its class, so a Cloudflare fallback under load is a failure.
// A class passes when each guest receives advancing video and audio from every other guest within the join limit
// (timed from the class's last SDK join call), and again after the hold. Each class writes its evidence to its own
// class-N folder. The report goes to .private/prod-proof/<run>/sfu-classes-<provider>.json; the exit code is
// non-zero when any class fails. Run it on Instabox: eighteen browsers are too many for a laptop.
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { check, mediaPlane, save } from "./runtime.mjs";
import { runStandalone } from "./standalone.mjs";
import { launchGuests, pollRendering } from "./media.mjs";
import { proveAudioDecoded } from "./audio-decode.mjs";
import { createSpace, episodeEnd, postEpisode } from "./proofs.mjs";
import { growing } from "./sfu-canary-criteria.mjs";

const options = parseArgs({
  options: {
    classes: { type: "string", default: "6" },
    guests: { type: "string", default: "3" },
    "hold-seconds": { type: "string", default: "60" },
    "join-limit-ms": { type: "string", default: "30000" },
  },
}).values;
const classes = Number(options.classes);
const guestCount = Number(options.guests);
const holdMs = Number(options["hold-seconds"]) * 1000;
const joinLimitMs = Number(options["join-limit-ms"]);

// Every guest receives advancing camera video and microphone audio from every other guest in its class.
const allRendering = (after, before, guests) => after.length === guests && after.every((rows, guest) => growing(rows, before[guest], "video", "camera") >= guests - 1 && growing(rows, before[guest], "audio", "microphone") >= guests - 1);

const rendersWithin = (pages, startedAt, limitMs, label) =>
  pollRendering(pages, startedAt, limitMs, `${label}: not every guest received advancing video and audio from every other guest within ${limitMs} ms`, (current, previous) => allRendering(current, previous, pages.length), 1000);

// All classes create their Space and Episode first, then launch their guests together. A class that fails early
// still arrives, so the others never wait for it.
function createBarrier(parties) {
  const arrived = new Set();
  let release;
  const open = new Promise((resolve) => (release = resolve));
  return (id) => {
    arrived.add(id);
    if (arrived.size === parties) release();
    return open;
  };
}

async function runClass(run, receiver, index, arrive) {
  const startedAt = performance.now();
  const owned = {};
  try {
    const directory = `${run.directory}/class-${index}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const classRun = { ...run, directory };
    const space = await createSpace(classRun);
    const { episode, path } = await postEpisode(run, space, { class: index });
    owned.ending = episodeEnd(run, path);
    await arrive(index);
    let joinStartedAt = performance.now();
    // The class's join is timed from its last guest's SDK join call; the earlier guests are ready by then.
    const guests = await launchGuests(classRun, space, episode, null, receiver.origin, true, guestCount, { onJoinStart: (guest, at) => guest === guestCount - 1 && (joinStartedAt = at) });
    owned.ending.useSDK(guests.pages[0]);
    const joinedMs = await rendersWithin(guests.pages, joinStartedAt, joinLimitMs, `class ${index} join`);
    await sleep(holdMs);
    await rendersWithin(guests.pages, performance.now(), 15_000, `class ${index} after the hold`);
    await proveAudioDecoded(guests); // The bytes kept advancing; the class must also still hear every tone.
    return { class: index, result: "passed", joinedMs, totalMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return { class: index, result: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    arrive(index);
    await owned.ending?.end().catch(() => {});
  }
}

function validate() {
  check(Number.isInteger(classes) && classes >= 1 && Number.isInteger(guestCount) && guestCount >= 2, "--classes must be at least 1 and --guests at least 2", "configuration");
  check(Number.isFinite(holdMs) && holdMs >= 0 && Number.isFinite(joinLimitMs) && joinLimitMs > 0, "--hold-seconds must be a number from 0 and --join-limit-ms a number above 0", "configuration");
}

async function main() {
  const report = { provider: mediaPlane, startedAt: new Date().toISOString(), flags: { classes, guests: guestCount, holdSeconds: holdMs / 1000, joinLimitMs }, classes: [] };
  const { directory } = await runStandalone("sfu-classes", report, async (run, receiver) => {
    const arrive = createBarrier(classes);
    report.classes = await Promise.all([...Array(classes).keys()].map((index) => runClass(run, receiver, index + 1, arrive)));
  }, { validate });
  const failed = report.classes.filter((entry) => entry.result !== "passed").length;
  report.result = !report.error && !report.cleanupError && report.classes.length === classes && failed === 0 ? "passed" : "failed";
  await save(`${directory}/sfu-classes-${mediaPlane}.json`, report);
  console.log(JSON.stringify({ provider: mediaPlane, result: report.result, classes: report.classes }, null, 2));
  console.log(`Private evidence: ${directory}`);
  if (report.result !== "passed") process.exitCode = 1;
}

if (import.meta.main) await main();
