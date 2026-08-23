import assert from "node:assert/strict";
import test from "node:test";

import { parseCli, createRunId } from "../config.mjs";
import { aggregateTraceSummaries, compareReports, summarizeCpuProfile, summarizeMetrics, summarizeProcesses, summarizeSteps } from "../analysis.mjs";
import { deltaSample, diffHeapSummaries } from "../metrics.mjs";
import { summarizeTrace } from "../tracing.mjs";

test("CLI validates mode duration and Participant limits", () => {
  assert.equal(parseCli(["profile", "--minutes", "30", "--participants", "3", "--base", "http://localhost:13070"]).durationMs, 1_800_000);
  assert.equal(parseCli(["shakedown", "--seconds", "300", "--participants", "4"]).durationMs, 300_000);
  assert.throws(() => parseCli(["profile", "--minutes", "29"]), /between 30 and 45/);
  assert.throws(() => parseCli(["shakedown", "--seconds", "301"]), /between 60 and 300/);
  assert.throws(() => parseCli(["shakedown", "--participants", "2"]), /between 3 and 4/);
});

test("run identifiers remain unique and filesystem-safe", () => {
  const id = createRunId(new Date("2026-08-23T12:34:56.789Z"), 0);
  assert.match(id, /^2026-08-23T12-34-56-789Z-000000$/);
});

test("metric deltas preserve null when a counter is unavailable", () => {
  assert.deepEqual(deltaSample({ jsHeapUsed: 10, nodes: null, layoutCount: 2 }, { jsHeapUsed: 18, nodes: 9, layoutCount: 5 }), {
    jsHeapUsedDelta: 8,
    nodesDelta: null,
    listenersDelta: null,
    documentsDelta: null,
    layoutCountDelta: 3,
    recalcStyleCountDelta: null,
    scriptDurationDelta: null,
    taskDurationDelta: null,
    layoutDurationDelta: null,
    recalcStyleDurationDelta: null,
  });
});

test("heap diff reports class-level count and byte changes", () => {
  const diff = diffHeapSummaries(
    { file: "before", nodeCount: 10, totalSelfSize: 100, classes: { Alpha: { count: 2, selfSize: 20 }, Gone: { count: 1, selfSize: 10 } } },
    { file: "after", nodeCount: 13, totalSelfSize: 140, classes: { Alpha: { count: 3, selfSize: 30 }, New: { count: 2, selfSize: 20 } } },
  );
  assert.equal(diff.nodeCountDelta, 3);
  assert.equal(diff.totalSelfSizeDelta, 40);
  assert.deepEqual(
    diff.classes.find((entry) => entry.name === "Alpha"),
    {
      name: "Alpha",
      countDelta: 1,
      selfSizeDelta: 10,
      beforeCount: 2,
      afterCount: 3,
      beforeSelfSize: 20,
      afterSelfSize: 30,
    },
  );
});

test("metric and step summaries expose before-after and feature failure rows", () => {
  const metrics = summarizeMetrics([
    { kind: "drift", driftMs: 4 },
    { kind: "sample", participant: "Avery", url: "about:blank", jsHeapUsed: 1, nodes: 1, listeners: 0, documents: 1, layoutCount: 0, recalcStyleCount: 0 },
    { kind: "sample", participant: "Avery", jsHeapUsed: 100, nodes: 4, listeners: 2, documents: 1, layoutCount: 3, recalcStyleCount: 2 },
    { kind: "sample", participant: "Avery", jsHeapUsed: 150, nodes: 5, listeners: 3, documents: 1, layoutCount: 7, recalcStyleCount: 4 },
    { kind: "error", participant: "Blake", error: "page closed" },
  ]);
  assert.equal(metrics.participants.Avery.beforeAfter.jsHeapUsed, 50);
  assert.equal(metrics.liveSampleCount, 2);
  assert.equal(metrics.setupSampleCount, 1);
  assert.equal(metrics.errorCount, 1);
  const steps = summarizeSteps([
    { event: "step", feature: "chat-send", ok: true, ms: 10 },
    { event: "step", feature: "chat-send", ok: false, ms: 3, error: "unavailable" },
  ]);
  assert.equal(steps.byFeature["chat-send"].failed, 1);
  assert.equal(steps.failureCount, 1);
});

test("browser process samples aggregate concurrent renderer and GPU CPU", () => {
  const processes = summarizeProcesses([
    { processType: "renderer", processId: 1, sampledAt: 1, cpuTimeDelta: 0.2, cpuPercent: 20 },
    { processType: "renderer", processId: 2, sampledAt: 1, cpuTimeDelta: 0.1, cpuPercent: 10 },
    { processType: "renderer", processId: 1, sampledAt: 2, cpuTimeDelta: 0.4, cpuPercent: 40 },
    { processType: "gpu-process", processId: 3, sampledAt: 1, cpuTimeDelta: 0.05, cpuPercent: 5 },
  ]);
  assert.equal(processes.renderer.averageCpuPercent, 35);
  assert.equal(processes.renderer.maxProcessCount, 2);
  assert.equal(processes["gpu-process"].cpuSecondsDelta, 0.05);
});

test("trace summarizer aggregates paint and compositor counts", () => {
  const summary = summarizeTrace({
    feature: "whiteboard",
    durationMs: 1000,
    participants: [
      { counts: { Paint: 2, CompositeLayers: 3 }, durationsMicros: { Layout: 10 }, topFunctions: [{ functionName: "apply", url: "/packages/whiteboard/presence.ts", line: 82, calls: 2, durationMicros: 30 }] },
      { counts: { Paint: 4, RasterTask: 1 }, durationsMicros: { Layout: 5 }, topFunctions: [{ functionName: "apply", url: "/packages/whiteboard/presence.ts", line: 82, calls: 3, durationMicros: 20 }] },
    ],
  });
  assert.deepEqual(summary.counts, { Paint: 6, CompositeLayers: 3, RasterTask: 1 });
  assert.equal(summary.durationsMicros.Layout, 15);
  assert.equal(summary.topFunctions[0].calls, 5);
});

test("trace aggregation normalizes counts by participant time", () => {
  const [summary] = aggregateTraceSummaries([
    { feature: "whiteboard", durationMs: 1_000, participantCount: 4, counts: { Paint: 20 }, durationsMicros: { Layout: 20_000 } },
    { feature: "whiteboard", durationMs: 2_000, participantCount: 4, counts: { Paint: 40 }, durationsMicros: { Layout: 40_000 } },
  ]);
  assert.equal(summary.occurrences, 2);
  assert.equal(summary.countsPerParticipantSecond.Paint, 5);
  assert.equal(summary.durationPercent.Layout, 0.5);
});

test("CPU summary ranks application self time", () => {
  const summary = summarizeCpuProfile(
    {
      startTime: 0,
      endTime: 3_000,
      samples: [1, 2, 2],
      timeDeltas: [1_000, 1_000, 1_000],
      nodes: [
        { id: 1, callFrame: { functionName: "idle", url: "", lineNumber: 0, columnNumber: 0 } },
        { id: 2, callFrame: { functionName: "renderStage", url: "http://localhost:13070/sdks/typescript/react/src/Stage.tsx", lineNumber: 9, columnNumber: 2 } },
      ],
    },
    "cpu.cpuprofile",
  );
  assert.equal(summary.topApplicationFrames[0].functionName, "renderStage");
  assert.equal(summary.topApplicationFrames[0].selfMs, 2);
});

test("run comparator reports before-after metric deltas", () => {
  const comparison = compareReports(
    { runId: "before", metrics: { participants: { Avery: { beforeAfter: { jsHeapUsed: 20 } } } }, traces: [{ feature: "camera-video", countsPerParticipantSecond: { Paint: 4 } }], steps: { failureCount: 2 }, heapDiffs: [] },
    { runId: "after", metrics: { participants: { Avery: { beforeAfter: { jsHeapUsed: 12 } } } }, traces: [{ feature: "camera-video", countsPerParticipantSecond: { Paint: 1 } }], steps: { failureCount: 1 }, heapDiffs: [] },
  );
  assert.equal(comparison.metrics.Avery.jsHeapUsed.delta, -8);
  assert.equal(comparison.traces["camera-video"].Paint.delta, -3);
  assert.equal(comparison.stepFailures.delta, -1);
});
