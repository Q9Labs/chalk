import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeHeap } from "./call-heap-summary.mjs";
import { installLeakObservers } from "./call-leak-observers.mjs";

export function growth(values) {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) throw new Error("Growth requires at least two finite samples");
  const center = (values.length - 1) / 2;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - center) * (value - average);
    denominator += (index - center) ** 2;
  });
  return numerator / denominator;
}

export function leakFailures(samples, budgets, { left = false } = {}) {
  return Object.entries(budgets.metrics).flatMap(([metric, limit]) => {
    const values = samples.map((sample) => sample[metric]);
    if (values.some((value) => !Number.isFinite(value))) throw new Error(`Missing leak measurement ${metric}`);
    const slope = growth(values);
    const excess = Math.max(...values.slice(1)) - values[0];
    return [
      ...(limit.tailPerCycle !== undefined && values.length >= 11 && growth(values.slice(-10)) > limit.tailPerCycle ? [`${metric}: late slope ${growth(values.slice(-10)).toFixed(4)} > ${limit.tailPerCycle}/cycle`] : []),
      ...(slope > limit.perCycle ? [`${metric}: slope ${slope.toFixed(4)} > ${limit.perCycle}/cycle`] : []),
      ...(excess > limit.allowance ? [`${metric}: baseline excess ${excess.toFixed(4)} > ${limit.allowance}`] : []),
      ...(left && ["liveTracks", "audioContexts"].includes(metric) && values.some((value) => value !== 0) ? [`${metric}: full leave must be zero`] : []),
    ];
  });
}

async function sample(page, cdp, settleMs) {
  await page.waitForTimeout(settleMs);
  let previous;
  for (let attempt = 0; attempt < 6; attempt++) {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(200);
    await cdp.send("HeapProfiler.collectGarbage");
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const counters = await cdp.send("Memory.getDOMCounters");
    const current = { heapMiB: metrics.JSHeapUsedSize / 1024 ** 2, domNodes: counters.nodes, listeners: counters.jsEventListeners, documents: counters.documents, ...(await page.evaluate(() => window.__callLeaks())) };
    // Do not choose a minimum: require consecutive stable resource counts, then
    // retain that actual reading. A continuing leak cannot be collected away.
    if (
      previous &&
      Object.keys(current)
        .filter((metric) => !["heapMiB", "animationFrames"].includes(metric))
        .every((metric) => current[metric] === previous[metric])
    )
      return current;
    previous = current;
  }
  throw new Error(`Resource teardown did not stabilize: ${JSON.stringify(previous)}`);
}

async function snapshot(cdp, directory, id) {
  await mkdir(directory, { recursive: true });
  const chunks = [];
  const receive = ({ chunk }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", receive);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: true });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", receive);
  }
  const path = resolve(directory, `${id}.heapsnapshot`);
  const serialized = chunks.join("");
  await writeFile(path, serialized);
  const summary = summarizeHeap(JSON.parse(serialized));
  console.log(`Leak snapshot ${path}: detached DOM nodes=${summary.detachedNodes}; largest retained object types=${JSON.stringify(summary.largestRetainedTypes)}`);
  return { path, ...summary };
}

export const LEAK_JOURNEYS = ["idle", "leave", "panels", "people", "share", "board", "reconnect", "layout", "reactions"];

export async function checkLeaks({ browser, origin, budgets, directory, boardCss, selfTest = false, repeats = 1, journeys = LEAK_JOURNEYS }) {
  if (!journeys.length || journeys.some((journey) => !LEAK_JOURNEYS.includes(journey))) throw new Error("Unknown leak journey");
  if (!Number.isInteger(budgets.cycles) || budgets.cycles < 20 || !Number.isFinite(budgets.settleMs) || budgets.settleMs < 500) throw new Error("Leak check requires 20 cycles and at least 500 ms settling");
  for (const metric of ["heapMiB", "domNodes", "listeners", "documents", "videos", "audios", "liveTracks", "audioContexts", "intervals", "animationFrames", "rosterCacheKeys"]) {
    const limit = budgets.metrics[metric];
    if (!limit || !Number.isFinite(limit.perCycle) || !Number.isFinite(limit.allowance) || limit.perCycle < 0 || limit.allowance < 0 || (limit.tailPerCycle !== undefined && (!Number.isFinite(limit.tailPerCycle) || limit.tailPerCycle < 0))) throw new Error(`Missing/invalid leak budget ${metric}`);
  }
  await mkdir(directory, { recursive: true });
  const results = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const journey of journeys) results.push(await run(journey, null, repeat));
  }
  const tests = [];
  if (selfTest) {
    const probe = await observerProbe(browser, budgets.settleMs);
    tests.push({ injection: "resource-lifecycle", detected: probe.detected, result: probe });
    const selfTestCycles = 5;
    for (const injection of ["listener", "detached"]) {
      const result = await run("panels", injection, 0, selfTestCycles);
      const metric = injection === "listener" ? "listeners" : "domNodes";
      tests.push({ injection, detected: result.failures.some((failure) => failure.startsWith(`${metric}:`)), result });
    }
    const clean = await run("panels", null, repeats, selfTestCycles);
    results.push(clean);
    tests.push({ injection: "none", detected: clean.samples.length === selfTestCycles + 1 && clean.failures.length === 0, result: clean });
  }
  return { results, selfTest: tests, failures: [...results.flatMap((result) => result.failures.map((failure) => `${result.journey}/${result.repeat}: ${failure}`)), ...tests.filter((test) => !test.detected).map((test) => `Leak self-test failed: ${test.injection}`)] };

  async function run(journey, injection, repeat, cycles = budgets.cycles) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "no-preference", serviceWorkers: "block" });
    await context.addInitScript(installLeakObservers);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await cdp.send("Performance.enable");
    await page.route("https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@*/dist/prod/index.css", (route) => route.fulfill({ path: boardCss, contentType: "text/css" }));
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ body: "", contentType: "text/css" }));
    try {
      await page.goto(`${origin}/call-states.html?state=perf-six`, { waitUntil: "load" });
      await page.getByRole("button", { name: "Leave call", exact: true }).waitFor();
      await page.waitForTimeout(1000);
      const fixture = async (name) => page.locator(`[data-perf-${name}]`).dispatchEvent("click");
      const click = async (name) => page.getByRole("button", { name, exact: true }).click();
      const cycle = async () => {
        if (journey === "idle") {
          await page.evaluate(() => undefined);
          await page.evaluate(() => undefined);
        } else if (journey === "leave") {
          if ((await page.getByRole("button", { name: "Leave call", exact: true }).count()) === 0) {
            await fixture("join");
            await page.getByRole("button", { name: "Leave call", exact: true }).waitFor();
            await page.waitForTimeout(100);
          }
          await click("Leave call");
          await page.getByRole("button", { name: "Leave call", exact: true }).waitFor({ state: "hidden" });
        } else if (journey === "panels") {
          for (const [open, close] of [
            ["Chat", "Close chat"],
            ["Participants", "Close participants panel"],
          ]) {
            await click(open);
            await page.getByRole("button", { name: close, exact: true }).waitFor();
            if (injection)
              await page.evaluate((kind) => {
                if (kind === "listener") document.addEventListener("chalk-leak-probe", () => Math.random());
                else {
                  window.__detachedLeak ??= [];
                  for (let i = 0; i < 30; i++) {
                    const node = document.createElement("section");
                    document.body.append(node);
                    node.remove();
                    window.__detachedLeak.push(node);
                  }
                }
              }, injection);
            await click(close);
            await page.getByRole("button", { name: close, exact: true }).waitFor({ state: "hidden" });
          }
        } else if (journey === "layout") {
          await click("Layout: Spotlight");
          await page.getByRole("menuitemradio", { name: /Grid/ }).click();
          await click("Layout: Grid");
          await page.getByRole("menuitemradio", { name: /Spotlight/ }).click();
        } else if (journey === "reactions") {
          await fixture("reactions");
          await page.waitForFunction(() => document.body.textContent.includes("🎉"));
          await page.waitForTimeout(4300);
        } else {
          const controls = { people: ["people-in", "people-out"], share: ["share-on", "share-off"], board: ["board-on", "board-off"], reconnect: ["reconnect", "recover"] }[journey];
          await fixture(controls[0]);
          if (journey === "board") await page.locator(".excalidraw canvas").first().waitFor({ state: "visible", timeout: 30000 });
          await page.waitForTimeout(400);
          await fixture(controls[1]);
          if (journey === "board") await page.locator(".excalidraw canvas").first().waitFor({ state: "hidden" });
        }
      };
      // Initial mount is joined. Bring it to the left state so warm-up exercises
      // the same rejoin path (including Playwright's dispatch helper) as all 20 cycles.
      if (journey === "leave") {
        await click("Leave call");
        await page.getByRole("button", { name: "Leave call", exact: true }).waitFor({ state: "hidden" });
      }
      await cycle();
      const samples = [await sample(page, cdp, budgets.settleMs)];
      for (let index = 0; index < cycles; index++) {
        await cycle();
        samples.push(await sample(page, cdp, budgets.settleMs));
      }
      if (errors.length) throw new Error(`${journey}: ${errors.join("; ")}`);
      const failures = leakFailures(samples, budgets, { left: journey === "leave" });
      const result = {
        journey,
        repeat,
        injection,
        cycles,
        samples,
        heapTailGrowth: samples.length >= 11 ? growth(samples.slice(-10).map((sample) => sample.heapMiB)) : null,
        growth: Object.fromEntries(Object.keys(budgets.metrics).map((metric) => [metric, growth(samples.map((value) => value[metric]))])),
        failures,
      };
      if (failures.length) result.evidence = await snapshot(cdp, directory, `${journey}-${repeat}-${injection ?? "clean"}`);
      await writeFile(resolve(directory, `${journey}-${repeat}-${injection ?? "clean"}.json`), `${JSON.stringify(result, null, 2)}\n`);
      console.log(`Leaks ${journey}/${repeat}${injection ? ` (${injection})` : ""}: ${failures.length ? failures.join("; ") : "PASS"}`);
      return result;
    } catch (error) {
      const result = { journey, repeat, injection, samples: [], growth: {}, failures: [`measurement error: ${error.stack ?? error}`] };
      await writeFile(resolve(directory, `${journey}-${repeat}-${injection ?? "clean"}.json`), `${JSON.stringify(result, null, 2)}\n`);
      console.error(result.failures[0]);
      return result;
    } finally {
      await context.close();
    }
  }
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
