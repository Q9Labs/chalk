import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { routeCallFixtureAssets } from "./call-fixture-routes.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { installLeakObservers } from "./call-leak-observers.mjs";
import { LEAK_JOURNEYS, journeyCycle, startJourney } from "./call-leak-journeys.mjs";
import { growth, leakFailures, sample, snapshot, waitForToastTeardown } from "./call-leak-sample.mjs";

export function leakShard(value) {
  if (!/^[1-9]\d*\/[1-9]\d*$/u.test(value)) throw new Error("Invalid leak shard; expected i/n");
  const [index, total] = value.split("/").map(Number);
  if (index > total || total > LEAK_JOURNEYS.length) throw new Error("Leak shard must select at least one journey");
  return { index, total, journeys: LEAK_JOURNEYS.filter((_, offset) => offset % total === index - 1), selfTest: index === 1 };
}

export function checkLeakShardReports(reports, total = 3) {
  if (reports.length !== total) throw new Error(`Expected ${total} leak shard reports, got ${reports.length}`);
  const seen = new Set();
  for (const report of reports) {
    const { index, total: reportedTotal } = report.leakShard ?? {};
    if (reportedTotal !== total || seen.has(index)) throw new Error("Missing or duplicate leak shard");
    const shard = leakShard(`${index}/${total}`);
    seen.add(index);
    if (report.errors?.length !== 0 || report.failures?.length !== 0 || report.leaks?.failures?.length !== 0) throw new Error(`Leak shard ${index} did not pass`);
    const repeats = report.leakRepeats;
    if (!Number.isInteger(repeats) || repeats < 1) throw new Error("Missing leak repeat count");
    const expected = shard.journeys.flatMap((journey) => Array.from({ length: repeats }, (_, repeat) => `${journey}/${repeat}`));
    if (shard.selfTest) expected.push(`panels/${repeats}`);
    const actual = report.leaks.results.map(({ journey, repeat }) => `${journey}/${repeat}`);
    if (JSON.stringify(actual.toSorted()) !== JSON.stringify(expected.toSorted())) throw new Error(`Leak shard ${index} journey coverage mismatch`);
    const tests = report.leaks.selfTest;
    const injections = shard.selfTest ? ["resource-lifecycle", "listener", "detached", "none"] : [];
    if (JSON.stringify(tests.map(({ injection }) => injection)) !== JSON.stringify(injections) || tests.some(({ detected }) => !detected)) throw new Error(`Leak shard ${index} self-test mismatch`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--check-shards") throw new Error("Expected --check-shards followed by report paths");
  checkLeakShardReports(await Promise.all(process.argv.slice(3).map(async (path) => JSON.parse(await readFile(path, "utf8")))));
  console.log(`Leak shard coverage: all ${LEAK_JOURNEYS.length} journeys and self-tests passed`);
}

function validateLeakRun({ journeys, budgets }) {
  if (!journeys.length || journeys.some((journey) => !LEAK_JOURNEYS.includes(journey))) throw new Error("Unknown leak journey");
  if (!Number.isInteger(budgets.cycles) || budgets.cycles < 20 || !Number.isFinite(budgets.settleMs) || budgets.settleMs < 500) throw new Error("Leak check requires 20 cycles and at least 500 ms settling");
  for (const metric of ["heapMiB", "domNodes", "listeners", "documents", "videos", "audios", "liveTracks", "audioContexts", "intervals", "animationFrames", "rosterCacheKeys"]) {
    const limit = budgets.metrics[metric];
    if (!limit || !Number.isFinite(limit.perCycle) || !Number.isFinite(limit.allowance) || limit.perCycle < 0 || limit.allowance < 0 || (limit.tailPerCycle !== undefined && (!Number.isFinite(limit.tailPerCycle) || limit.tailPerCycle < 0))) throw new Error(`Missing/invalid leak budget ${metric}`);
  }
}

async function openJourney({ browser, boardCss }) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "no-preference", serviceWorkers: "block" });
  await context.addInitScript(installLeakObservers);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await cdp.send("Performance.enable");
  await routeCallFixtureAssets(page, boardCss);
  return { context, page, cdp, errors };
}

async function loadCall(page, origin) {
  await page.goto(`${origin}/call-states.html?state=perf-six`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Leave call", exact: true }).waitFor();
  await page.waitForTimeout(1000);
}

/** Cold reading, warm-up cycles, a baseline, then the measured cycles. Returns the readings and the failures they show. */
async function measureJourney({ page, cdp, errors }, run, journey, injection, repeat, cycles) {
  const { budgets } = run;
  const cycle = journeyCycle(page, journey, injection);
  await startJourney(page, journey);
  await cycle();
  const cold = await sample(page, cdp, budgets.settleMs);
  // Mounting once leaves V8 compiling hot render paths throughout the measured
  // tail. Exercise the same journey before measuring steady-state heap growth.
  const warmupCycles = injection ? 1 : budgets.cycles;
  for (let index = 1; index < warmupCycles; index++) {
    await cycle();
    await waitForToastTeardown(page);
  }
  const baseline = warmupCycles === 1 ? cold : await sample(page, cdp, budgets.settleMs);
      // Warm-up must not hide retained resources, even if their growth later stops.
      const warmupFailures = Object.entries(budgets.metrics).flatMap(([metric, limit]) => (metric !== "heapMiB" && baseline[metric] - cold[metric] > limit.allowance ? [`${metric}: warm-up excess ${(baseline[metric] - cold[metric]).toFixed(4)} > ${limit.allowance}`] : []));
  const samples = [baseline];
  for (let index = 0; index < cycles; index++) {
    await cycle();
    samples.push(await sample(page, cdp, budgets.settleMs));
  }
  if (errors.length) throw new Error(`${journey}: ${errors.join("; ")}`);
  const failures = [...warmupFailures, ...leakFailures(samples, budgets, { left: journey === "leave" })];
  return {
    journey,
    repeat,
    injection,
    cycles,
    warmup: { cycles: warmupCycles, before: cold, after: baseline, failures: warmupFailures },
    samples,
    heapTailGrowth: samples.length >= 11 ? growth(samples.slice(-10).map((sample) => sample.heapMiB)) : null,
    growth: Object.fromEntries(Object.keys(budgets.metrics).map((metric) => [metric, growth(samples.map((value) => value[metric]))])),
    failures,
  };
}

const resultFile = ({ journey, repeat, injection }) => `${journey}-${repeat}-${injection ?? "clean"}`;

async function runJourney(run, journey, injection, repeat, cycles = run.budgets.cycles) {
  const open = await openJourney(run);
  try {
    await loadCall(open.page, run.origin);
    const result = await measureJourney(open, run, journey, injection, repeat, cycles);
    if (result.failures.length) result.evidence = await snapshot(open.cdp, run.directory, resultFile(result));
    await writeFile(resolve(run.directory, `${resultFile(result)}.json`), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Leaks ${journey}/${repeat}${injection ? ` (${injection})` : ""}: ${result.failures.length ? result.failures.join("; ") : "PASS"}`);
    return result;
  } catch (error) {
    const result = { journey, repeat, injection, samples: [], growth: {}, failures: [`measurement error: ${error.stack ?? error}`] };
    await writeFile(resolve(run.directory, `${resultFile(result)}.json`), `${JSON.stringify(result, null, 2)}\n`);
    console.error(result.failures[0]);
    return result;
  } finally {
    await open.context.close();
  }
}

/** Proves the check can see a leak: the observers see a made-up one, and injected leaks fail the ordinary budgets while a clean run passes. */
async function selfTestJob(run, repeats) {
  const { browser, budgets } = run;
  const tests = [];
  const probe = await observerProbe(browser, budgets.settleMs);
  tests.push({ injection: "resource-lifecycle", detected: probe.detected, result: probe });
  const selfTestCycles = 5;
  for (const injection of ["listener", "detached"]) {
    const result = await runJourney(run, "panels", injection, 0, selfTestCycles);
    const metric = injection === "listener" ? "listeners" : "domNodes";
    tests.push({ injection, detected: result.failures.some((failure) => failure.startsWith(`${metric}:`)), result });
  }
  const clean = await runJourney(run, "panels", null, repeats);
  tests.push({ injection: "none", detected: clean.samples.length === budgets.cycles + 1 && clean.failures.length === 0, result: clean });
  return { tests, clean };
}

export async function checkLeaks({ browser, origin, budgets, directory, boardCss, selfTest = false, repeats = 1, journeys = LEAK_JOURNEYS, journeyConcurrency = 1 }) {
  validateLeakRun({ journeys, budgets });
  await mkdir(directory, { recursive: true });
  const run = { browser, origin, budgets, boardCss, directory: await mkdtemp(resolve(directory, "run-")) };
  // Journeys wait on timers and garbage collection, so the browser is mostly idle: each runs in its own context
  // (its own renderer process), and a few at once keep the same measurements in a fraction of the time.
  // The reactions journey waits 4.3 s per cycle, so it starts first and does not set the finish time.
  const ordered = journeys.toSorted((a, b) => Number(b === "reactions") - Number(a === "reactions"));
  const journeyJobs = Array.from({ length: repeats }, (_, repeat) => ordered.map((journey) => () => runJourney(run, journey, null, repeat))).flat();
  const outcomes = await runPool(selfTest ? [() => selfTestJob(run, repeats), ...journeyJobs] : journeyJobs, journeyConcurrency);
  const selfTested = selfTest ? outcomes.shift() : undefined;
  const results = selfTested ? [...outcomes, selfTested.clean] : outcomes;
  const tests = selfTested?.tests ?? [];
  return { results, selfTest: tests, failures: [...results.flatMap((result) => result.failures.map((failure) => `${result.journey}/${result.repeat}: ${failure}`)), ...tests.filter((test) => !test.detected).map((test) => `Leak self-test failed: ${test.injection}`)] };
}

async function runPool(jobs, concurrency) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]();
    }
  };
  // Let started journeys finish so one setup failure does not close the browser under the others.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  const rejected = settled.find((outcome) => outcome.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}

async function observerProbe(browser, settleMs) {
  const context = await browser.newContext();
  await context.addInitScript(installLeakObservers);
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.goto("about:blank");
    await page.evaluate(() => {
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const canvas = document.createElement("canvas");
      const stream = canvas.captureStream();
      const video = document.createElement("video");
      const audio = document.createElement("audio");
      document.body.append(video, audio);
      video.remove();
      audio.remove();
      const resources = { roster: new Map([["perf-join-resource-probe", 1]]), audioContext, tracks: [...stream.getTracks(), ...destination.stream.getTracks()], video, audio, interval: setInterval(() => {}, 1000), frame: 0 };
      const frame = () => {
        resources.frame = requestAnimationFrame(frame);
      };
      frame();
      window.__leakProbe = resources;
    });
    const before = await sample(page, cdp, settleMs);
    await page.evaluate(async () => {
      const resources = window.__leakProbe;
      resources.tracks.forEach((track) => track.stop());
      await resources.audioContext.close();
      clearInterval(resources.interval);
      cancelAnimationFrame(resources.frame);
      delete window.__leakProbe;
    });
    const after = await sample(page, cdp, settleMs);
    const expected = { videos: 1, audios: 1, liveTracks: 2, audioContexts: 1, intervals: 1, animationFrames: 1, rosterCacheKeys: 1 };
    return { before, after, detected: Object.entries(expected).every(([metric, value]) => before[metric] === value && after[metric] === 0) };
  } finally {
    await context.close();
  }
}
