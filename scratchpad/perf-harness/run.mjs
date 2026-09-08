// Orchestrates a profiling run of the Chalk meeting web app.
//
//   node run.mjs [--minutes 35] [--participants 4] [--base http://127.0.0.1:13070]
//
// Outputs land in .private/chalk-perf/runs/<runId>/ :
//   metrics.ndjson          per-page samples every 5s (+deltas)
//   steps.ndjson            scenario step log
//   cpu-p1.cpuprofile       whole-run sampling profile (participant 1)
//   cpu-window-*.cpuprofile 1ms windowed profiles (participant 2)
//   snap-*.heapsnapshot     streamed V8 snapshots at defined beats
//   snap-*.summary.json     parsed summaries for diffing
//   traces/*.json           windowed timeline event counts

import { createRequire } from "node:module";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enableDomains, samplePage, deltaSample, startCpuProfile, stopCpuProfile, takeHeapSnapshot, summarizeHeapSnapshot, traceWindow } from "./collectors.mjs";
import * as scenario from "./scenario.mjs";

const harnessDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(harnessDir, "..", "..");

function parseArgs(argv) {
  const options = { minutes: Number(process.env.RUN_MINUTES ?? 35), participants: Number(process.env.PARTICIPANTS ?? 4), base: process.env.WEB_BASE ?? "http://127.0.0.1:13070" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--minutes") options.minutes = Number(argv[++index]);
    else if (argv[index] === "--participants") options.participants = Number(argv[++index]);
    else if (argv[index] === "--base") options.base = argv[++index];
  }
  return options;
}

const require = createRequire(join(repoRoot, "sdks", "typescript", "client", "package.json"));
const { chromium } = require("playwright");

const NAMES = ["Avery", "Blake", "Casey", "Devon"];

async function launchParticipant(browser, base) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["camera", "microphone"],
    baseURL: base,
  });
  await context.addInitScript(() => {
    window.__chalkPerf = { marks: [] };
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await enableDomains(cdp);
  page.setDefaultTimeout(15_000);
  return { context, page, cdp };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(repoRoot, ".private", "chalk-perf", "runs", runId);
  const tracesDir = join(outDir, "traces");
  await mkdir(tracesDir, { recursive: true });

  const metricsPath = join(outDir, "metrics.ndjson");
  const stepsPath = join(outDir, "steps.ndjson");
  stepLog = (entry) => {
    const line = `${JSON.stringify({ t: Date.now(), ...entry })}`;
    process.stdout.write(`[step] ${line.slice(0, 200)}\n`);
    return appendFile(stepsPath, `${line}\n`).catch(() => {});
  };

  log(`run ${runId}: ${options.participants} participants, ${options.minutes} min, base ${options.base}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"],
  });

  const people = [];
  for (let index = 0; index < options.participants; index += 1) {
    people.push({ name: NAMES[index] ?? `Guest${index}`, ...(await launchParticipant(browser, options.base)) });
  }

  // Metrics sampler: every 5s per participant (staggered by 500ms).
  const previousByPerson = new Map();
  const samplerTimer = setInterval(async () => {
    for (const [index, person] of people.entries()) {
      const sample = await samplePage(person.cdp, person.page).catch(() => null);
      if (!sample) continue;
      const row = { person: person.name, index, ...sample, ...deltaSample(previousByPerson.get(index), sample) };
      previousByPerson.set(index, sample);
      await appendFile(metricsPath, `${JSON.stringify(row)}\n`).catch(() => {});
    }
  }, 5_000);

  async function snapshot(tag, personIndex = 0) {
    const person = people[personIndex];
    const file = join(outDir, `snap-${tag}.heapsnapshot`);
    try {
      stepLog({ event: "snapshot-phase", tag, phase: "begin" });
      await takeHeapSnapshot(person.cdp, file);
      stepLog({ event: "snapshot-phase", tag, phase: "streamed" });
      const summary = await summarizeHeapSnapshot(file);
      summary.tag = tag;
      summary.person = person.name;
      await writeFile(join(outDir, `snap-${tag}.summary.json`), JSON.stringify(summary, null, 2));
      stepLog({ event: "snapshot-phase", tag, phase: "summarized", nodes: summary.nodeCount });
      log(`snapshot ${tag}: nodes=${summary.nodeCount} self=${(summary.totalSelfSize / 1e6).toFixed(1)}MB`);
    } catch (error) {
      stepLog({ event: "snapshot-failed", tag, reason: String(error).slice(0, 300) });
    }
  }

  async function windowedTrace(tag, personIndex, durationMs) {
    const person = people[personIndex];
    try {
      const result = await traceWindow(person.page, durationMs);
      await writeFile(join(tracesDir, `trace-${tag}.json`), JSON.stringify(result, null, 2));
      log(`trace ${tag} (${person.name}): ${JSON.stringify(result.counts)}`);
    } catch (error) {
      stepLog({ event: "trace-failed", tag, reason: String(error).slice(0, 200) });
    }
  }

  // --- Phase A: joins ------------------------------------------------------
  const host = people[0];
  let inviteURL;
  await startCpuProfile(host.cdp, 5_000); // whole-run, low rate
  inviteURL = await step("host join", () => scenario.joinAsHost(host.page, host.name, (event) => stepLog({ event: "join-progress", ...event })));
  if (!inviteURL) throw new Error("host join failed; aborting run");
  await snapshot("p1-after-join", 0);

  const joinStaggerMs = 15_000;
  for (let index = 1; index < people.length; index += 1) {
    const person = people[index];
    await step(`${person.name} join`, () => scenario.joinWithInvite(person.page, inviteURL, person.name));
    await sleep(joinStaggerMs);
  }
  await snapshot("all-joined", 0);

  // --- Phase B: feature loop ----------------------------------------------
  const startedAt = Date.now();
  const deadline = startedAt + options.minutes * 60_000;
  let round = 0;
  let leaveRoundDone = false;

  while (Date.now() < deadline) {
    round += 1;
    const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
    log(`round ${round} begins (${elapsedMin} min elapsed)`);

    // Join/leave/rejoin cycles around rounds 3 and 6.
    if ((round === 3 || round === 6) && !leaveRoundDone && people.length >= 4) {
      const guest = people[people.length - 1];
      await snapshot("p4-before-leave", people.length - 1);
      await step(`${guest.name} leave`, () => scenario.leaveViaDialog(guest.page));
      await sleep(60_000);
      await step(`${guest.name} rejoin`, () => scenario.joinWithInvite(guest.page, inviteURL, guest.name));
      await snapshot("p4-after-rejoin", people.length - 1);
      leaveRoundDone = true;
      continue;
    }

    // Media toggles, staggered.
    for (const [index, person] of people.entries()) {
      await step(`${person.name} mic toggle`, () =>
        scenario
          .toggleMic(person.page)
          .then(() => sleep(400))
          .then(() => scenario.toggleMic(person.page)),
      );
      if (index % 2 === 1) {
        await step(`${person.name} camera toggle`, () =>
          scenario
            .toggleCamera(person.page)
            .then(() => sleep(600))
            .then(() => scenario.toggleCamera(person.page)),
        );
      }
      await step(`${person.name} hand raise`, () =>
        scenario
          .toggleHandRaise(person.page)
          .then(() => sleep(700))
          .then(() => scenario.toggleHandRaise(person.page)),
      );
    }

    // Chat burst + history scroll (every participant needs its own panel open).
    const chatOpen = await step("open chat panel", () => scenario.openPanel(host.page, "chat"));
    if (chatOpen) {
      for (const person of people.slice(1)) {
        await step(`open chat panel ${person.name}`, () => scenario.openPanel(person.page, "chat"));
      }
      for (const [index, person] of people.entries()) {
        await step(`${person.name} chat send r${round}-${index}`, () => scenario.sendChatMessage(person.page, `perf round ${round} message ${index}`));
      }
      await step("chat history scroll", () => scenario.scrollChatHistory(host.page, "up", 4));
      await step("chat scroll back", () => scenario.scrollChatHistory(host.page, "down", 4));
      if (round % 2 === 0) {
        await step("chat file upload", () => uploadFixtureFile(people[1].page, round));
        await step("send attachment", () => scenario.sendChatMessage(people[1].page, `attachment round ${round}`));
      }
      await step("close chat panel", () => scenario.closeTopmost(host.page));
      for (const person of people.slice(1)) {
        await step(`close chat panel ${person.name}`, () => scenario.closeTopmost(person.page));
      }
    }

    // Panel open/close cycle with heap comparison beats (first two rounds).
    // Transcript is omitted: local API runs with transcription disabled, so the
    // control does not render here.
    if (round <= 2) await snapshot(`panels-before-r${round}`, 0);
    for (const kind of ["participants", "settings"]) {
      await step(`open ${kind} panel r${round}`, () => scenario.openPanel(host.page, kind));
      await sleep(1_500);
      await step(`close ${kind} panel r${round}`, () => scenario.closeTopmost(host.page));
    }
    if (round <= 2) {
      await snapshot(`panels-after-r${round}`, 0);
    }

    // Layout switching.
    for (const layout of ["grid", "spotlight", "presentation", "spotlight"]) {
      await step(`layout ${layout} r${round}`, () => scenario.switchLayout(host.page, layout));
      await sleep(800);
    }

    // Reactions burst with a paint trace on the host page.
    const reactionTrace = windowedTrace(`reactions-r${round}`, 0, 6_000);
    await step("reactions burst", async () => {
      for (const [index, person] of people.entries()) {
        await scenario.sendReaction(person.page, ["👍", "🎉", "❤️"][index % 3]).catch(() => {});
        await sleep(250);
      }
      await sleep(3_500); // let animations play inside the trace window
    });
    await reactionTrace;

    // Screen share with video trace.
    await step("screen share start", () => scenario.toggleScreenShare(people[1].page));
    await sleep(4_000);
    const shareTrace = windowedTrace(`screenshare-r${round}`, 0, 8_000);
    await step("share view interaction", async () => {
      const stage = host.page.locator('[data-tour="video-grid"]').first();
      const box = await stage.boundingBox();
      if (box) await scenario.dragOnStage(host.page, box, 120, 40);
    });
    await shareTrace;
    await step("screen share stop", () => scenario.toggleScreenShare(people[1].page));

    // Whiteboard every other round.
    if (round % 2 === 1) {
      await step("whiteboard open", () => scenario.whiteboardToggle(host.page));
      await sleep(2_000);
      const drawTrace = windowedTrace(`whiteboard-r${round}`, 0, 8_000);
      await step("whiteboard draw", () => scenario.whiteboardDraw(host.page, 3));
      await drawTrace;
      await step("whiteboard pan/zoom", () => scenario.whiteboardPanZoom(host.page));
      await step("whiteboard close", () => scenario.whiteboardToggle(host.page));
    }

    // Windowed 1ms CPU profile for participant 2 during the busiest stretch.
    await step("cpu window p2", async () => {
      await startCpuProfile(people[1].cdp, 1_000);
      for (const person of people) {
        await scenario.toggleMic(person.page).catch(() => {});
        await sleep(150);
      }
      await stopCpuProfile(people[1].cdp, join(outDir, `cpu-window-r${round}.cpuprofile`));
    });

    const remaining = deadline - Date.now();
    log(`round ${round} done; ${Math.max(0, Math.round(remaining / 1000))}s left`);
    if (remaining > 20_000) await sleep(Math.min(remaining, 20_000));
  }

  // --- Phase C: teardown ---------------------------------------------------
  clearInterval(samplerTimer);
  for (const [index, person] of people.entries()) {
    await step(`${person.name} final leave`, () => scenario.leaveViaDialog(person.page)).catch(() => {});
    void index;
  }
  await sleep(30_000);
  await snapshot("p1-final-after-all-left", 0);
  const cpuSummary = await stopCpuProfile(host.cdp, join(outDir, "cpu-p1.cpuprofile")).catch((error) => ({ error: String(error) }));

  await writeFile(join(outDir, "run-meta.json"), JSON.stringify({ runId, options, cpuSummary, rounds: round, finishedAt: new Date().toISOString() }, null, 2));
  log(`done; outputs in ${outDir}`);
  await browser.close();
}

// --- helpers ---

// Rebound inside main() once the output directory is known.
let stepLog = () => {};

async function uploadFixtureFile(page, round) {
  const fixturePath = join(repoRoot, ".private", "chalk-perf", "fixtures", `upload-${round}.txt`);
  const content = `perf fixture ${round}: ${"x".repeat(2048)}`;
  await mkdir(join(repoRoot, ".private", "chalk-perf", "fixtures"), { recursive: true });
  await writeFile(fixturePath, content);
  await scenario.uploadChatFile(page, fixturePath);
}

async function step(label, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    await stepLog({ event: "step", label, ok: true, ms: Date.now() - startedAt });
    return result ?? true;
  } catch (error) {
    await stepLog({ event: "step", label, ok: false, ms: Date.now() - startedAt, reason: String(error).slice(0, 240) });
    return false;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  process.stdout.write(`[harness] ${new Date().toISOString()} ${message}\n`);
}

process.on("unhandledRejection", (reason) => {
  process.stdout.write(`[harness] UNHANDLED REJECTION ${String(reason?.stack || reason).slice(0, 600)}\n`);
});

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
