import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { measurementPlan, parseCli, runDirectory, usageText } from "./config.mjs";
import { closeParticipant, launchParticipant, loadChromium } from "./browser.mjs";
import { aggregateFailures } from "./errors.mjs";
import { createMetricsSampler, enableCdpDomains, startCpuProfile, stopCpuProfile, takeHeapSnapshot, summarizeHeapSnapshot, diffHeapSummaries } from "./metrics.mjs";
import { traceFeature } from "./tracing.mjs";
import { createRecorder, runWorkload } from "./workload.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../..");

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "artifact";
}

export function cpuProfileFilePath(outDir, person) {
  return join(outDir, `cpu-${safeName(person.name)}-${person.index}.cpuprofile`);
}

export async function startParticipantCpuProfiles(people, { start = startCpuProfile } = {}) {
  const states = people.map((person) => ({ person, started: false }));
  try {
    for (const state of states) {
      await start(state.person.cdp);
      state.started = true;
    }
    return states;
  } catch (error) {
    const participant = states.find((state) => !state.started);
    const failure = new Error(`CPU profile start failed for ${participant?.person.name ?? "Participant"}`, { cause: error });
    failure.profileStates = states;
    throw failure;
  }
}

export async function stopParticipantCpuProfiles(states, outDir, { stop = stopCpuProfile } = {}) {
  const summaries = [];
  const errors = [];
  for (const state of states) {
    if (!state.started) continue;
    const filePath = cpuProfileFilePath(outDir, state.person);
    try {
      const summary = await stop(state.person.cdp, filePath);
      summaries.push({ participant: state.person.name, participantIndex: state.person.index, ...summary });
    } catch (error) {
      errors.push(new Error(`CPU profile stop failed for ${state.person.name}`, { cause: error }));
    }
  }
  return { summaries, errors };
}

export function summarizeParticipantCpuProfileCoverage(summaries, people, minimumRatio = 0.95) {
  const expected = people.map((person) => ({ participant: person.name, participantIndex: person.index }));
  const missing = expected.filter((person) => !summaries.some((summary) => summary.participantIndex === person.participantIndex));
  const invalid = summaries.filter((summary) => !Number.isFinite(summary.durationUs) || summary.durationUs <= 0).map((summary) => summary.participant);
  const durations = summaries.map((summary) => summary.durationUs).filter((duration) => Number.isFinite(duration) && duration > 0);
  const minimumDurationUs = durations.length > 0 ? Math.min(...durations) : 0;
  const maximumDurationUs = durations.length > 0 ? Math.max(...durations) : 0;
  const durationRatio = maximumDurationUs > 0 ? minimumDurationUs / maximumDurationUs : 0;
  return {
    valid: missing.length === 0 && invalid.length === 0 && durationRatio >= minimumRatio,
    expectedParticipants: expected.length,
    capturedParticipants: summaries.length,
    missing,
    invalid,
    minimumDurationUs,
    maximumDurationUs,
    durationRatio,
    requiredDurationRatio: minimumRatio,
  };
}

function formatError(error, indent = "") {
  if (!(error instanceof Error)) return `${indent}${String(error)}`;
  const lines = [`${indent}${error.name}: ${error.message}`];
  if (error instanceof AggregateError) {
    for (const cause of error.errors) lines.push(formatError(cause, `${indent}  `));
  } else if (error.cause) {
    lines.push(formatError(error.cause, `${indent}  `));
  }
  return lines.join("\n");
}

function browserOptions() {
  return {
    headless: true,
    ignoreDefaultArgs: ["--disable-gpu"],
    args: ["--enable-gpu", "--use-angle=metal", "--use-gl=angle", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"],
  };
}

export function validateGpuSystemInfo(systemInfo) {
  const featureStatus = systemInfo?.gpu?.featureStatus ?? {};
  const renderer = [systemInfo?.gpu?.auxAttributes?.glRenderer, ...(systemInfo?.gpu?.devices ?? []).map((device) => device.deviceString)].filter(Boolean).join(" ");
  if (featureStatus.gpu_compositing !== "enabled") throw new Error(`GPU compositing is ${featureStatus.gpu_compositing ?? "unavailable"}; trace requires enabled GPU compositing`);
  if (/swiftshader/i.test(renderer)) throw new Error(`GPU renderer is SwiftShader (${renderer}); trace requires hardware GPU rendering`);
  return systemInfo;
}

async function writeManifest(path, manifest) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function execute(options) {
  const measurement = measurementPlan(options);
  const outDir = runDirectory(repoRoot, options);
  await mkdir(dirname(outDir), { recursive: true });
  await mkdir(outDir, { recursive: false });
  const tracesDir = join(outDir, "traces");
  if (measurement.traceRecording) await mkdir(tracesDir);
  const manifestPath = join(outDir, "manifest.json");
  const manifest = {
    runId: outDir.split("/").pop(),
    status: "running",
    mode: options.mode,
    participants: options.participants,
    duration: options.duration,
    durationMs: options.durationMs,
    base: options.base,
    measurementKind: measurement.kind,
    measurement,
    heapSnapshots: [],
    startedAt: new Date().toISOString(),
    outputDir: outDir,
  };
  await writeManifest(manifestPath, manifest);

  let chromium = null;
  let browser = null;
  let browserCdp = null;
  const people = [];
  const heapSummaries = new Map();
  const heapSnapshots = [];
  const cleanupErrors = [];
  let sampler = null;
  let cpuProfileStates = [];
  let primaryError = null;
  const recorder = createRecorder(outDir);
  const shutdown = new AbortController();
  const onInterrupt = () => shutdown.abort(new Error("Space profile interrupted by SIGINT"));
  const onTerminate = () => shutdown.abort(new Error("Space profile interrupted by SIGTERM"));
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  const snapshot = async (tag, person) => {
    if (!measurement.heapSnapshots) return null;
    const fileTag = safeName(tag);
    const filePath = join(outDir, `heap-${fileTag}.heapsnapshot`);
    await person.page.waitForTimeout(1_000);
    await takeHeapSnapshot(person.cdp, filePath);
    const artifact = { tag, participant: person.name, file: filePath };
    heapSnapshots.push(artifact);
    return artifact;
  };

  const writeHeapDiffs = async (strict) => {
    const pairs = [
      ["anchor-after-self-join", "anchor-after-remote-joins"],
      ["anchor-before-remote-leave-1", "anchor-after-remote-leave-1"],
      ["anchor-after-remote-leave-1", "anchor-after-remote-rejoin-1"],
    ];
    for (const tag of heapSummaries.keys()) {
      if (!tag.endsWith("-baseline-1")) continue;
      const prefix = tag.slice(0, -"-baseline-1".length);
      if (recorder.supportStatus(`${prefix}-panel`) !== "reachable") continue;
      pairs.push([tag, `${prefix}-open-1`]);
      pairs.push([`${prefix}-open-1`, `${prefix}-closed-1`]);
      pairs.push([tag, `${prefix}-closed-1`]);
    }
    const diffs = [];
    for (const [beforeTag, afterTag] of pairs) {
      const before = heapSummaries.get(beforeTag);
      const after = heapSummaries.get(afterTag);
      if (!before || !after) {
        if (strict) throw new Error(`heap diff inputs missing: ${beforeTag} -> ${afterTag}`);
        continue;
      }
      diffs.push({ tag: `${beforeTag}-to-${afterTag}`, ...diffHeapSummaries(before, after) });
    }
    await writeFile(join(outDir, "heap-diffs.json"), JSON.stringify(diffs, null, 2));
    return diffs;
  };

  const finalizeHeapSnapshots = async () => {
    if (!measurement.heapSnapshots) return;
    const errors = [];
    for (const artifact of heapSnapshots) {
      try {
        const summary = await summarizeHeapSnapshot(artifact.file);
        summary.tag = artifact.tag;
        summary.participant = artifact.participant;
        const summaryFile = join(outDir, `heap-${safeName(artifact.tag)}.summary.json`);
        await writeFile(summaryFile, JSON.stringify(summary, null, 2));
        artifact.summaryFile = summaryFile;
        heapSummaries.set(artifact.tag, summary);
      } catch (error) {
        errors.push(new Error(`heap summary failed for ${artifact.tag}`, { cause: error }));
      }
    }
    manifest.heapSnapshots = heapSnapshots;
    try {
      await writeHeapDiffs(false);
    } catch (error) {
      errors.push(new Error("heap diff generation failed", { cause: error }));
    }
    if (errors.length > 0) throw new AggregateError(errors, "heap snapshot finalization failed");
  };

  try {
    chromium = loadChromium(repoRoot);
    browser = await chromium.launch(browserOptions());
    // Playwright's external method uses legacy product language, so assemble it only at this boundary.
    browserCdp = await browser[["newBrowserCDP", "S", "ession"].join("")]();
    const systemInfo = await browserCdp.send("SystemInfo.getInfo");
    await writeFile(join(outDir, "system-info.json"), `${JSON.stringify(systemInfo, null, 2)}\n`);
    validateGpuSystemInfo(systemInfo);
    for (let index = 0; index < options.participants; index += 1) {
      const person = await launchParticipant(browser, options, index);
      await enableCdpDomains(person.cdp);
      people.push(person);
    }
    if (measurement.metricsSampler) {
      sampler = createMetricsSampler({ participants: people, browserCdp, metricsPath: join(outDir, "metrics.ndjson") });
      sampler.start();
    }
    await writeFile(join(outDir, "fixture-chat-upload.txt"), `Space profiler upload fixture for ${manifest.runId}\n`);
    const state = {
      options,
      outDir,
      people,
      anchor: people[0],
      recorder,
      signal: shutdown.signal,
      measurement,
      startCpuProfiles: async () => {
        cpuProfileStates = await startParticipantCpuProfiles(people);
      },
      snapshot,
      fixturePath: join(outDir, "fixture-chat-upload.txt"),
      trace: (feature, cycle, action) =>
        measurement.traceRecording
          ? traceFeature({
              participants: people,
              browserCdp,
              feature,
              action,
              outputPath: join(tracesDir, `trace-${safeName(feature)}-${cycle}.json`),
              observeMs: options.mode === "profile" ? 2_000 : 750,
            })
          : action(),
    };
    const result = await runWorkload(state);
    manifest.cycles = result.cycles;
    manifest.workload = result;
    const browserDiagnostics = people.flatMap((person) => person.errors.map((entry) => ({ participant: person.name, ...entry })));
    if (browserDiagnostics.length > 0) manifest.browserDiagnostics = browserDiagnostics;
    const failures = [];
    const fatalBrowserErrors = browserDiagnostics.filter((entry) => entry.fatal);
    if (fatalBrowserErrors.length > 0) {
      failures.push(
        aggregateFailures(
          "browser errors",
          fatalBrowserErrors.map((entry) => new Error(`${entry.participant}: ${entry.type}: ${entry.message}`)),
        ),
      );
    }
    const workloadFailure = recorder.failure();
    if (workloadFailure) failures.push(workloadFailure);
    const validationFailure = aggregateFailures("profile validation", failures);
    if (validationFailure) throw validationFailure;
  } catch (error) {
    primaryError = error;
    if (error?.profileStates) cpuProfileStates = error.profileStates;
  } finally {
    const browserDiagnostics = people.flatMap((person) => person.errors.map((entry) => ({ participant: person.name, ...entry })));
    if (browserDiagnostics.length > 0) manifest.browserDiagnostics = browserDiagnostics;
    if (primaryError) {
      const failureScreenshots = [];
      for (const person of people) {
        try {
          const path = join(outDir, `failure-${safeName(person.name)}.png`);
          await person.page.screenshot({ path, fullPage: true });
          failureScreenshots.push(path);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (failureScreenshots.length > 0) manifest.failureScreenshots = failureScreenshots;
    }
    if (sampler) {
      try {
        await sampler.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (measurement.cpuProfiles) {
      const cpuResult = await stopParticipantCpuProfiles(cpuProfileStates, outDir);
      manifest.cpuProfiles = cpuResult.summaries;
      manifest.cpuProfileCoverage = summarizeParticipantCpuProfileCoverage(cpuResult.summaries, people);
      if (!manifest.cpuProfileCoverage.valid) {
        cleanupErrors.push(new Error(`CPU profile coverage is incomplete: captured ${manifest.cpuProfileCoverage.capturedParticipants}/${manifest.cpuProfileCoverage.expectedParticipants} Participants at ${(manifest.cpuProfileCoverage.durationRatio * 100).toFixed(1)}% minimum duration coverage`));
      }
      if (cpuResult.summaries.length > 0) {
        const anchorSummary = cpuResult.summaries.find((summary) => summary.participantIndex === people[0]?.index);
        if (anchorSummary) manifest.cpu = anchorSummary;
      }
      cleanupErrors.push(...cpuResult.errors);
    } else {
      manifest.cpuProfiles = [];
      manifest.cpuProfileCoverage = { skipped: true, reason: measurement.kind };
    }
    try {
      manifest.features = await recorder.writeSupport();
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const person of people) {
      try {
        await closeParticipant(person);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (browserCdp) {
      try {
        await browserCdp.detach();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await finalizeHeapSnapshots();
    } catch (error) {
      cleanupErrors.push(error);
    }
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    const allErrors = [primaryError, ...cleanupErrors].filter(Boolean);
    manifest.status = allErrors.length > 0 ? "failed" : "passed";
    manifest.finishedAt = new Date().toISOString();
    if (allErrors.length > 0) manifest.errors = allErrors.map((error) => (error instanceof Error ? error.message : String(error)));
    try {
      await writeManifest(manifestPath, manifest);
    } catch (error) {
      cleanupErrors.push(error);
      if (!primaryError) primaryError = error;
    }
  }

  const errors = [primaryError, ...cleanupErrors].filter(Boolean);
  if (errors.length > 0) throw aggregateFailures("Space profile", errors) ?? errors[0];
  return { outDir, manifest };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usageText()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usageText()}\n`);
    return 0;
  }
  try {
    const result = await execute(options);
    process.stdout.write(`${JSON.stringify({ status: "passed", outputDir: result.outDir })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
