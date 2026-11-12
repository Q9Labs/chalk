#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { cpus, loadavg, platform, arch } from "node:os";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { serveBuild } from "./call-performance-server.mjs";
import { calibrate } from "./call-performance-page.mjs";
import { measure } from "./call-performance-measure.mjs";
import { checkLeaks, leakShard } from "./call-leak-check.mjs";
import { LEAK_JOURNEYS } from "./call-leak-journeys.mjs";
import { measureRouteBundle } from "./call-route-bundle.mjs";
import { validateBudgets, validateScenarioBudgets, summarize, budgetFailures, METRICS, BUNDLE_METRICS } from "./call-performance-metrics.mjs";
import { scenarios } from "./call-performance-scenarios.mjs";
import { readBudgets } from "../../../features/scorecard/budgets.mjs";
import { loadCallBudgets } from "../../../features/scorecard/call-budgets.mjs";

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
    shard: { type: "string" },
    "leak-journey": { type: "string" },
    "leak-repeats": { type: "string", default: "1" },
    "journey-concurrency": { type: "string", default: "3" },
    diagnostics: { type: "boolean" },
    shots: { type: "string", default: process.env.CALL_PERFORMANCE_SHOTS },
    "record-baseline": { type: "boolean" },
  },
});
if (values["leaks-only"] && values["timing-only"]) throw new Error("Choose either leaks-only or timing-only");
if (values.gate && (values.smoke || values["record-baseline"] || values["leak-journey"])) throw new Error("Gate runs cannot narrow journeys or collect an unenforced baseline");
if (values.gate && !values["leaks-only"] && !process.env.TESTBOX_SOURCE_COMMIT) values["bundle-only"] = true;
if (values.gate && !values["bundle-only"]) values["self-test"] = true;
if (values["leak-journey"] && !LEAK_JOURNEYS.includes(values["leak-journey"])) throw new Error("Unknown leak journey");
if (values.shard && (!values["leaks-only"] || values["bundle-only"] || values["leak-journey"])) throw new Error("Shards require leaks-only without bundle-only or leak-journey");
const shard = values.shard ? leakShard(values.shard) : undefined;
const web = resolve(import.meta.dirname, "..");
const root = resolve(web, "../..");
const dist = resolve(web, ".call-performance");
const budgets = loadCallBudgets(await readBudgets());
validateBudgets(budgets);
if (!values["record-baseline"]) validateScenarioBudgets(budgets, scenarios);
if (!values["skip-build"]) {
  execFileSync("pnpm", ["exec", "turbo", "run", "build", "--filter=web..."], { cwd: root, stdio: "inherit", timeout: 300_000 });
  execFileSync("pnpm", ["exec", "vite", "build", "--config", "vite.call-performance.config.ts"], { cwd: web, stdio: "inherit", timeout: 300_000 });
}
const report = {
  source: process.env.TESTBOX_SOURCE_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  baselineCommit: budgets.baselineCommit,
  recordedAt: new Date().toISOString(),
  machine: { platform: platform(), arch: arch(), cpu: cpus()[0].model, cores: cpus().length, load: loadavg() },
  mode: values["bundle-only"] ? "bundle-only" : values["leaks-only"] ? "leaks-only" : values["timing-only"] ? "timing-only" : "full",
  ...(shard ? { leakShard: { index: shard.index, total: shard.total }, leakRepeats: Number(values["leak-repeats"]) } : {}),
  devices: budgets.devices,
  calibration: [],
  results: [],
  failures: [],
  warnings: [],
  errors: [],
  selfTest: null,
  diagnostics: [],
};
const server = await serveBuild(dist);
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let deadline;

async function checkRouteBundle() {
  report.routeBundle = await measureRouteBundle({ browser, web });
  for (const metric of ["routeJsGzipKiB", "routeCssGzipKiB"]) {
    const value = report.routeBundle[metric];
    console.log(`Production route ${metric}: ${value.toFixed(1)}/${budgets.limits[metric]}`);
    if (value > budgets.limits[metric]) (budgets.warnOnly.includes(`route/${metric}`) ? report.warnings : report.failures).push(`${metric} ${value.toFixed(2)} > ${budgets.limits[metric]}`);
  }
}

async function runDiagnostics(session) {
  for (const [deviceName, device] of Object.entries(budgets.devices)) {
    for (const mode of ["paused-video", "unthrottled"]) {
      const sample = await measure(session, mode === "unthrottled" ? { ...device, cpu: 1 } : device, { id: "calm-six", state: "perf-six" }, { pauseVideo: mode === "paused-video" });
      report.diagnostics.push({ device: deviceName, mode, sample });
      console.log(`Diagnostic ${deviceName}/${mode}: frame p95 ${sample.frameP95Ms.toFixed(1)} ms`);
    }
  }
}

/** Measures one scenario on one device the budgeted number of times and records what passed, what failed and what only warns. */
async function runScenario(session, deviceName, device, scenario) {
  const repeats = values["bundle-only"] || values.smoke ? 1 : budgets.repeats;
  const samples = [];
  for (let repeat = 0; repeat < repeats; repeat++) samples.push(await measure(session, device, scenario, { capture: repeat === 0 ? `${deviceName}-${scenario.id}` : null }));
  const summary = summarize(samples);
  const limits = { ...budgets.limits, ...budgets.scenarios?.[deviceName]?.[scenario.id] };
  const checked = values["bundle-only"] ? BUNDLE_METRICS : METRICS.filter((metric) => metric !== "firstCallMs" || scenario.id === "first-load");
  const failures = [];
  const warnings = [];
  for (const metric of checked) {
    const over = budgetFailures(summary, limits, [metric]).map((failure) => `${deviceName}/${scenario.id}: ${failure}`);
    (budgets.warnOnly.includes(`${deviceName}/${scenario.id}/${metric}`) ? warnings : failures).push(...over);
  }
  report.results.push({ device: deviceName, scenario: scenario.id, samples, summary, limits, failures, warnings });
  report.failures.push(...failures);
  report.warnings.push(...warnings);
  console.log(`${deviceName.padEnd(7)} ${scenario.id.padEnd(16)} ${checked.map((metric) => `${metric}=${summary[metric].median.toFixed(1)}/${limits[metric]}`).join(" ")}`);
}

async function runDevices(session) {
  for (const [deviceName, device] of Object.entries(budgets.devices)) {
    const calibration = await calibrate(browser, device);
    report.calibration.push({ device: deviceName, ...calibration });
    if (!values["bundle-only"] && (calibration.frameP95Ms > 25 || calibration.frameMedianMs < 12)) throw new Error(`Unusable headless frame clock on ${deviceName}: ${JSON.stringify(calibration)}`);
    for (const scenario of scenarios) await runScenario(session, deviceName, device, scenario);
  }
}

/** Slows every click on purpose and checks the ordinary budgets catch it, so a green run means the check can see regressions. */
async function runSelfTest(session) {
  const limits = { ...budgets.limits, ...budgets.scenarios?.laptop?.panels };
  const injectionMs = Math.max(250, limits.interactionMs + 100, limits.blockingMs / 4 + 100);
  const injected = await measure(session, budgets.devices.laptop, { id: "panels", state: "perf-six" }, { inject: injectionMs });
  const failures = budgetFailures(summarize([injected]), limits, ["interactionMs", "blockingMs"]);
  const detected = failures.length > 0 && injected.blockingMs > 150 && injected.interactionMs >= 200;
  report.selfTest = { detected, injectionMs, injected, failures, expected: "A busy loop above the configured click budget must fail the ordinary budget evaluator." };
  if (!detected) report.failures.push("Self-test did not detect the injected click slowdown");
  console.log(`Self-test: ${detected ? "PASS (injected regression detected)" : "FAIL"}`);
}

async function runLeaks() {
  const repeats = Number(values["leak-repeats"]);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("Invalid leak repeats");
  if (!Number.isInteger(Number(values["journey-concurrency"])) || Number(values["journey-concurrency"]) < 1) throw new Error("Invalid journey concurrency");
  report.leaks = await checkLeaks({
    browser,
    origin,
    budgets: budgets.leaks,
    directory: resolve(root, "artifacts/call-leaks"),
    boardCss: resolve(root, "packages/whiteboard/node_modules/@excalidraw/excalidraw/dist/prod/index.css"),
    selfTest: values["self-test"] && (!shard || shard.selfTest),
    journeyConcurrency: Number(values["journey-concurrency"]),
    repeats,
    journeys: shard?.journeys ?? (values["leak-journey"] ? [values["leak-journey"]] : undefined),
  });
  report.failures.push(...report.leaks.failures);
}

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
  const session = { browser, origin, root, values, sampleMs: budgets.sampleMs };
  if (!values["leaks-only"]) {
    await checkRouteBundle();
    if (values.diagnostics) await runDiagnostics(session);
    await runDevices(session);
    if (values["self-test"]) await runSelfTest(session);
  }
  if (!values["bundle-only"] && !values["timing-only"]) await runLeaks();
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
for (const warning of report.warnings) console.warn(`Over a warn-only budget: ${warning}`);
if (report.errors.length || report.selfTest?.detected === false || (!values["record-baseline"] && report.failures.length)) process.exitCode = 1;
