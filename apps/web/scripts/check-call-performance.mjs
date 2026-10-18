#!/usr/bin/env node
import { routeCallFixtureAssets } from "./call-fixture-routes.mjs";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { cpus, loadavg, platform, arch } from "node:os";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { serveBuild } from "./call-performance-server.mjs";
import { installVideoQualityObserver, videoCounterDelta } from "./call-video-quality.mjs";
import { checkLeaks, LEAK_JOURNEYS } from "./call-leak-check.mjs";
import { measureRouteBundle } from "./call-route-bundle.mjs";
import { validateBudgets, summarize, percentile, budgetFailures, trustedInteractionMs, METRICS, BUNDLE_METRICS } from "./call-performance-metrics.mjs";

const runStarted = performance.now();
const { values } = parseArgs({
  options: {
    out: { type: "string", default: "artifacts/call-performance.json" },
    gate: { type: "boolean" },
    "skip-build": { type: "boolean" },
    "bundle-only": { type: "boolean" },
    "self-test": { type: "boolean" },
    smoke: { type: "boolean" },
    "leaks-only": { type: "boolean" },
    "timing-only": { type: "boolean" },
    "leak-journey": { type: "string" },
    "leak-repeats": { type: "string", default: "1" },
    diagnostics: { type: "boolean" },
    shots: { type: "string", default: process.env.CALL_PERFORMANCE_SHOTS },
    "record-baseline": { type: "boolean" },
  },
});
if (values["leaks-only"] && values["timing-only"]) throw new Error("Choose either leaks-only or timing-only");
if (values.gate && (values.smoke || values["record-baseline"] || values["leak-journey"])) throw new Error("Gate runs cannot narrow journeys or collect an unenforced baseline");
if (values.gate && !process.env.TESTBOX_SOURCE_COMMIT) values["bundle-only"] = true;
if (values.gate && !values["bundle-only"]) values["self-test"] = true;
if (values["leak-journey"] && !LEAK_JOURNEYS.includes(values["leak-journey"])) throw new Error("Unknown leak journey");
const web = resolve(import.meta.dirname, "..");
const root = resolve(web, "../..");
const dist = resolve(web, ".call-performance");
const budgets = JSON.parse(await readFile(resolve(web, "perf-budgets.json"), "utf8"));
validateBudgets(budgets);
const scenarios = [
  { id: "calm-six", state: "perf-six" },
  { id: "grid-24", state: "perf-grid" },
  { id: "panels", state: "perf-six" },
  { id: "spotlight-share", state: "perf-share" },
  { id: "board", state: "perf-board" },
  { id: "reactions", state: "perf-six" },
  { id: "reconnect", state: "perf-six" },
  { id: "first-load", state: "perf-six" },
];
if (!values["record-baseline"]) {
  for (const device of Object.keys(budgets.devices)) {
    for (const scenario of scenarios) {
      const limits = budgets.scenarios?.[device]?.[scenario.id];
      for (const metric of METRICS.filter((metric) => metric !== "firstCallMs" || scenario.id === "first-load")) {
        if (!Number.isFinite(limits?.[metric])) throw new Error(`Missing explicit scenario budget: ${device}/${scenario.id}/${metric}`);
      }
    }
  }
}
if (!values["skip-build"]) {
  execFileSync("pnpm", ["run", "build"], { cwd: web, stdio: "inherit", timeout: 300_000 });
  execFileSync("pnpm", ["exec", "vite", "build", "--config", "vite.call-performance.config.ts"], { cwd: web, stdio: "inherit", timeout: 300_000 });
}
const report = {
  source: process.env.TESTBOX_SOURCE_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  baselineCommit: budgets.baselineCommit,
  recordedAt: new Date().toISOString(),
  machine: { platform: platform(), arch: arch(), cpu: cpus()[0].model, cores: cpus().length, load: loadavg() },
  mode: values["bundle-only"] ? "bundle-only" : values["leaks-only"] ? "leaks-only" : values["timing-only"] ? "timing-only" : "full",
  devices: budgets.devices,
  calibration: [],
  results: [],
  failures: [],
  errors: [],
  selfTest: null,
  diagnostics: [],
};
const server = await serveBuild(dist);
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let deadline;
try {
  deadline = setTimeout(
    () => {
      report.errors.push("Performance check exceeded its deadline");
      void browser?.close();
    },
    values["leaks-only"] ? Math.max(1_200_000, (Number(values["leak-repeats"]) * 10 + 5) * 60_000) : 1_200_000,
  );
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  if (!values["leaks-only"]) {
    report.routeBundle = await measureRouteBundle({ browser, web });
    for (const metric of ["routeJsGzipKiB", "routeCssGzipKiB"]) {
      const value = report.routeBundle[metric];
      console.log(`Production route ${metric}: ${value.toFixed(1)}/${budgets.limits[metric]}`);
      if (value > budgets.limits[metric]) report.failures.push(`${metric} ${value.toFixed(2)} > ${budgets.limits[metric]}`);
    }
    if (values.diagnostics) {
      for (const [deviceName, device] of Object.entries(budgets.devices)) {
        for (const mode of ["paused-video", "unthrottled"]) {
          const sample = await measure(mode === "unthrottled" ? { ...device, cpu: 1 } : device, { id: "calm-six", state: "perf-six" }, { pauseVideo: mode === "paused-video" });
          report.diagnostics.push({ device: deviceName, mode, sample });
          console.log(`Diagnostic ${deviceName}/${mode}: frame p95 ${sample.frameP95Ms.toFixed(1)} ms`);
        }
      }
    }
    for (const [deviceName, device] of Object.entries(budgets.devices)) {
      const calibration = await calibrate(device);
      report.calibration.push({ device: deviceName, ...calibration });
      if (!values["bundle-only"] && (calibration.frameP95Ms > 25 || calibration.frameMedianMs < 12)) throw new Error(`Unusable headless frame clock on ${deviceName}: ${JSON.stringify(calibration)}`);
      for (const scenario of scenarios) {
        const samples = [];
        const repeats = values["bundle-only"] || values.smoke ? 1 : budgets.repeats;
        for (let repeat = 0; repeat < repeats; repeat++) samples.push(await measure(device, scenario, { capture: repeat === 0 ? `${deviceName}-${scenario.id}` : null }));
        const summary = summarize(samples);
        const limits = { ...budgets.limits, ...budgets.scenarios?.[deviceName]?.[scenario.id] };
        const checked = values["bundle-only"] ? BUNDLE_METRICS : METRICS.filter((metric) => metric !== "firstCallMs" || scenario.id === "first-load");
        const failures = budgetFailures(summary, limits, checked).map((failure) => `${deviceName}/${scenario.id}: ${failure}`);
        report.results.push({ device: deviceName, scenario: scenario.id, samples, summary, limits, failures });
        report.failures.push(...failures);
        console.log(`${deviceName.padEnd(7)} ${scenario.id.padEnd(16)} ${checked.map((metric) => `${metric}=${summary[metric].median.toFixed(1)}/${limits[metric]}`).join(" ")}`);
      }
    }
    if (values["self-test"]) {
      const limits = { ...budgets.limits, ...budgets.scenarios?.laptop?.panels };
      const injectionMs = Math.max(250, limits.interactionMs + 100, limits.blockingMs / 4 + 100);
      const injected = await measure(budgets.devices.laptop, { id: "panels", state: "perf-six" }, { inject: injectionMs });
      const failures = budgetFailures(summarize([injected]), limits, ["interactionMs", "blockingMs"]);
      const detected = failures.length > 0 && injected.blockingMs > 150 && injected.interactionMs >= 200;
      report.selfTest = { detected, injectionMs, injected, failures, expected: "A busy loop above the configured click budget must fail the ordinary budget evaluator." };
      if (!detected) report.failures.push("Self-test did not detect the injected click slowdown");
      console.log(`Self-test: ${detected ? "PASS (injected regression detected)" : "FAIL"}`);
    }
  }
  if (!values["bundle-only"] && !values["timing-only"]) {
    const repeats = Number(values["leak-repeats"]);
    if (!Number.isInteger(repeats) || repeats < 1) throw new Error("Invalid leak repeats");
    report.leaks = await checkLeaks({
      browser,
      origin,
      budgets: budgets.leaks,
      directory: resolve(root, "artifacts/call-leaks"),
      boardCss: resolve(root, "packages/whiteboard/node_modules/@excalidraw/excalidraw/dist/prod/index.css"),
      selfTest: values["self-test"],
      repeats,
      journeys: values["leak-journey"] ? [values["leak-journey"]] : undefined,
    });
    report.failures.push(...report.leaks.failures);
  }
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  console.error(error);
} finally {
  report.elapsedMs = performance.now() - runStarted;
  clearTimeout(deadline);
  await browser?.close();
  await new Promise((done) => server.close(done));
  const output = resolve(root, values.out);
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${output}`);
}
if (report.errors.length || report.selfTest?.detected === false || (!values["record-baseline"] && report.failures.length)) process.exitCode = 1;

function installObservers() {
  const data = { frames: [], tasks: [], events: [], start: performance.now(), last: null, clicks: 0, trustedInputs: [], layoutShift: 0, layoutShifts: [] };
  window.__callPerf = data;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (entry.startTime >= data.start) {
        data.layoutShift += entry.value;
        data.layoutShifts.push({
          value: entry.value,
          startTime: entry.startTime,
          hadRecentInput: entry.hadRecentInput,
          sources: (entry.sources ?? []).map((source) => ({ tag: source.node?.nodeName, class: source.node?.getAttribute?.("class")?.slice(0, 160), previousRect: source.previousRect.toJSON(), currentRect: source.currentRect.toJSON() })),
        });
      }
  }).observe({ type: "layout-shift", buffered: true });
  const frame = (at) => {
    if (data.last !== null) data.frames.push(at - data.last);
    data.last = at;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.startTime >= data.start) data.tasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.startTime >= data.start && entry.interactionId) data.events.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name, interactionId: entry.interactionId });
  }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  for (const name of ["pointerdown", "pointerup", "click"]) {
    document.addEventListener(
      name,
      (event) => {
        if (!event.isTrusted) return;
        data.trustedInputs.push({ name: event.type, at: event.timeStamp });
        if (event.type === "click") data.clicks++;
      },
      true,
    );
  }
}
async function newPage(device) {
  const context = await browser.newContext({ viewport: device.viewport, hasTouch: device.touch, isMobile: device.touch, deviceScaleFactor: 1, reducedMotion: "no-preference", serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: device.cpu });
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.addInitScript(installObservers);
  await page.addInitScript({ content: `(${installVideoQualityObserver.toString()})(${videoCounterDelta.toString()})` });
  return { context, page, cdp };
}
async function calibrate(device) {
  const { context, page } = await newPage(device);
  try {
    await page.goto("about:blank");
    await page.evaluate(installObservers);
    await page.waitForTimeout(1200);
    const frames = await page.evaluate(() => window.__callPerf.frames);
    return { frameMedianMs: percentile(frames, 0.5), frameP95Ms: percentile(frames, 0.95), samples: frames.length };
  } finally {
    await context.close();
  }
}
async function measure(device, scenario, { inject = false, pauseVideo = false, capture = null } = {}) {
  const { context, page, cdp } = await newPage(device);
  const errors = [];
  const resources = new Map();
  page.on("requestfailed", (request) => {
    if (["script", "stylesheet"].includes(request.resourceType())) errors.push(`${request.failure()?.errorText} ${request.url()}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && ["script", "stylesheet"].includes(response.request().resourceType())) errors.push(`${response.status()} ${response.url()}`);
    if (["script", "stylesheet"].includes(response.request().resourceType())) resources.set(response.url(), response);
  });
  const boardCss = resolve(root, "packages/whiteboard/node_modules/@excalidraw/excalidraw/dist/prod/index.css");
  await routeCallFixtureAssets(page, boardCss);
  try {
    await stat(boardCss);
    await page.goto(`${origin}/call-states.html?state=${scenario.state}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Leave call", exact: true }).waitFor();
    await page.waitForFunction(() => {
      return [...document.querySelectorAll("video")].some((video) => {
        const box = video.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight && video.readyState >= 2 && video.videoWidth > 0;
      });
    });
    const firstCallMs = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now())))));
    if (pauseVideo) await page.evaluate(() => document.querySelectorAll("video").forEach((video) => video.pause()));
    if (scenario.id !== "first-load") {
      await page.waitForTimeout(1000);
      await page.evaluate(() => Object.assign(window.__callPerf, { frames: [], tasks: [], events: [], start: performance.now(), last: null, clicks: 0, trustedInputs: [], layoutShift: 0, layoutShifts: [] }));
    }
    await page.evaluate(() => {
      window.__callVideoQuality.reset();
    });
    if (inject)
      await page.evaluate(
        (busyMs) =>
          document.addEventListener(
            "click",
            (event) => {
              if (!event.isTrusted) return;
              const end = performance.now() + busyMs;
              while (performance.now() < end) {}
            },
            true,
          ),
        inject,
      );
    const click = async (name) => {
      const button = page.getByRole("button", { name, exact: true });
      if (device.touch) await button.tap();
      else await button.click();
      await page.waitForTimeout(350);
    };
    if (scenario.id === "panels") {
      await click("Chat");
      await page.getByRole("complementary", { name: "Chat panel" }).waitFor();
      await click("Close panel");
      await page.getByRole("complementary", { name: "Chat panel" }).waitFor({ state: "hidden" });
      await click("Participants");
      await page.getByRole("button", { name: "Close panel", exact: true }).waitFor();
      await click("Close panel");
    }
    if (scenario.id === "board") {
      const canvas = page.locator(".excalidraw canvas").first();
      await canvas.waitFor({ state: "visible", timeout: 30_000 });
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40, { steps: 12 });
      await page.mouse.up();
    }
    if (scenario.id === "reactions") {
      await page.locator("[data-perf-reactions]").dispatchEvent("click");
      await page.waitForFunction(() => document.body.textContent.includes("🎉"));
    }
    if (scenario.id === "reconnect") {
      await page.locator("[data-perf-reconnect]").dispatchEvent("click");
      await page.locator('[data-call-limbo][data-covered="true"][aria-hidden="false"]').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(350);
      await page.locator("[data-perf-recover]").dispatchEvent("click");
      await page.locator('[data-call-limbo][data-covered="false"][aria-hidden="true"]').waitFor({ state: "attached" });
      await page.getByRole("button", { name: "Leave call", exact: true }).click({ trial: true });
    }
    await page.waitForTimeout(budgets.sampleMs);
    const data = await page.evaluate(() => ({
      ...window.__callPerf,
      videoQuality: window.__callVideoQuality.snapshot(),
      supported: PerformanceObserver.supportedEntryTypes,
      durationMs: performance.now() - window.__callPerf.start,
      videos: [...document.querySelectorAll("video")].map((video) => ({ paused: video.paused, readyState: video.readyState, frames: video.getVideoPlaybackQuality().totalVideoFrames, droppedFrames: video.getVideoPlaybackQuality().droppedVideoFrames })),
    }));
    if (!values["bundle-only"] && (!data.supported.includes("event") || !data.supported.includes("longtask") || data.frames.length < 2)) throw new Error(`Missing performance observations for ${scenario.id}: ${JSON.stringify(data)}`);
    if (scenario.id === "panels" && data.clicks !== 4) throw new Error(`Expected four trusted panel clicks, got ${data.clicks}`);
    const trustedEvents = data.events.filter((entry) => data.trustedInputs.some((input) => input.name === entry.name && Math.abs(input.at - entry.startTime) < 1));
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const dom = await cdp.send("Memory.getDOMCounters");
    let jsGzipKiB = 0;
    let cssGzipKiB = 0;
    const loaded = [];
    for (const [url, response] of resources) {
      const size = gzipSync(await response.body(), { level: 9 }).length / 1024;
      if (response.request().resourceType() === "script") jsGzipKiB += size;
      else cssGzipKiB += size;
      loaded.push({ url: url.replace(origin, ""), gzipKiB: size });
    }
    if (errors.length) throw new Error(`${scenario.id}: ${errors.join("; ")}`);
    if (capture && values.shots) {
      const directory = resolve(root, values.shots);
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: resolve(directory, `${capture}.png`) });
    }
    const missed = data.frames.reduce((sum, ms) => sum + Math.max(0, Math.round(ms / (1000 / 60)) - 1), 0);
    return {
      layoutShift: data.layoutShift,
      layoutShifts: data.layoutShifts,
      videoDroppedFramePercent: data.videoQuality.frames ? (100 * data.videoQuality.dropped) / data.videoQuality.frames : data.videoQuality.dropped ? 100 : 0,
      videoQuality: data.videoQuality,
      frameP95Ms: data.frames.length ? percentile(data.frames, 0.95) : null,
      droppedFramePercent: data.frames.length ? (100 * missed) / (missed + data.frames.length) : null,
      longTasks: data.tasks.length,
      blockingMs: data.tasks.reduce((sum, ms) => sum + Math.max(0, ms - 50), 0),
      interactionMs: trustedInteractionMs(data.events, data.trustedInputs),
      heapMiB: metrics.JSHeapUsedSize / 1024 ** 2,
      domNodes: dom.nodes,
      ...(scenario.id === "first-load" ? { firstCallMs } : {}),
      jsGzipKiB,
      cssGzipKiB,
      durationMs: data.durationMs,
      frameSamples: data.frames.length,
      trustedClicks: data.clicks,
      eventEntries: trustedEvents.length,
      eventTimings: trustedEvents,
      inputTimings: data.trustedInputs,
      rawEventTimings: data.events,
      videos: data.videos,
      loaded,
    };
  } catch (error) {
    await mkdir(resolve(root, "artifacts"), { recursive: true });
    await page.screenshot({ path: resolve(root, "artifacts/performance-failure.png"), timeout: 5000 });
    await writeFile(resolve(root, "artifacts/performance-failure.html"), await page.content());
    throw error;
  } finally {
    await context.close();
  }
}
