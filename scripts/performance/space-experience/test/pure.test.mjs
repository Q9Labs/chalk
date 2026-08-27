import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDiagnosticRecorder } from "../browser.mjs";
import { measurementPlan, parseCli } from "../config.mjs";
import { TraceLifecycleError } from "../errors.mjs";
import { analyzeRun } from "../analysis.mjs";
import { createChatScrollWork } from "../../../../sdks/typescript/react/src/components/composite/chat-panel-model.ts";
import { createRecorder, runLeaveRejoin, shouldContinueCycles } from "../workload.mjs";

test("CLI validates mode duration and Participant limits", () => {
  assert.equal(parseCli(["profile", "--minutes", "30", "--participants", "3", "--base", "http://localhost:13070"]).durationMs, 1_800_000);
  assert.equal(parseCli(["shakedown", "--seconds", "300", "--participants", "4"]).durationMs, 300_000);
  const snapshotPass = parseCli(["shakedown", "--snapshot-pass", "--seconds", "60"]);
  assert.equal(snapshotPass.snapshotPass, true);
  assert.equal(parseCli(["shakedown", "--trace-pass"]).tracePass, true);
  assert.throws(() => parseCli(["profile", "--snapshot-pass"]), /only valid for shakedown/);
  assert.throws(() => parseCli(["profile", "--trace-pass"]), /only valid for shakedown/);
  assert.throws(() => parseCli(["shakedown", "--trace-pass", "--snapshot-pass"]), /mutually exclusive/);
  assert.throws(() => parseCli(["shakedown", "--snapshot-pass", "--seconds", "59"]), /between 60 and 300/);
  assert.throws(() => parseCli(["profile", "--minutes", "29"]), /between 30 and 45/);
  assert.throws(() => parseCli(["shakedown", "--seconds", "301"]), /between 60 and 300/);
  assert.throws(() => parseCli(["shakedown", "--participants", "2"]), /between 3 and 4/);
});

test("measurement plan keeps runtime profiling separate from the one-cycle snapshot pass", () => {
  const runtimeMeasurement = measurementPlan(parseCli(["shakedown"]));
  assert.deepEqual(runtimeMeasurement, {
    kind: "runtime-profile",
    heapSnapshots: false,
    metricsSampler: true,
    cpuProfiles: true,
    traceRecording: false,
    singleCycle: false,
  });
  const traceMeasurement = measurementPlan(parseCli(["shakedown", "--trace-pass"]));
  assert.deepEqual(traceMeasurement, {
    kind: "trace-pass",
    heapSnapshots: false,
    metricsSampler: false,
    cpuProfiles: false,
    traceRecording: true,
    singleCycle: true,
  });
  const snapshotMeasurement = measurementPlan(parseCli(["shakedown", "--snapshot-pass"]));
  assert.deepEqual(snapshotMeasurement, {
    kind: "snapshot-pass",
    heapSnapshots: true,
    metricsSampler: false,
    cpuProfiles: false,
    traceRecording: false,
    singleCycle: true,
  });
  assert.equal(shouldContinueCycles(runtimeMeasurement, 0, 1), true);
  assert.equal(shouldContinueCycles(traceMeasurement, 0, 1), false);
  assert.equal(shouldContinueCycles(snapshotMeasurement, 0, 1), false);
});

test("browser diagnostics coalesce repeats and remove URL query data", () => {
  const entries = [];
  let tick = 0;
  const record = createDiagnosticRecorder(entries, () => `tick-${(tick += 1)}`);
  record({ type: "websocket-error", fatal: false, url: "wss://example.test/socket?token=secret", message: "closed" });
  record({ type: "websocket-error", fatal: false, url: "wss://example.test/socket?token=other", message: "closed" });
  assert.deepEqual(entries, [
    {
      type: "websocket-error",
      fatal: false,
      url: "wss://example.test/socket",
      message: "closed",
      count: 2,
      firstAt: "tick-1",
      lastAt: "tick-2",
    },
  ]);
});

test("chat scroll blocks auto-scroll before its deferred visibility scan", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let scheduledFrame;
  globalThis.requestAnimationFrame = (callback) => {
    scheduledFrame = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const scroller = {
      scrollHeight: 1_000,
      scrollTop: 100,
      clientHeight: 200,
      getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
      querySelectorAll: () => [],
    };
    let atBottom = true;
    const scrollWork = createChatScrollWork({
      getScroller: () => scroller,
      getLatestSequence: () => null,
      lastMarkedSequenceRef: { current: null },
      onAtBottomChange: (next) => {
        atBottom = next;
      },
    });

    scrollWork.onScroll();

    assert.equal(atBottom, false);
    assert.equal(typeof scheduledFrame, "function");
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("trace lifecycle failures abort the workload after recording evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-recorder-test-"));
  try {
    const recorder = createRecorder(directory);
    const failure = new TraceLifecycleError("browser trace is tainted");
    await assert.rejects(
      recorder.step("camera trace", () => Promise.reject(failure), { feature: "camera-video" }),
      (error) => error === failure,
    );
    assert.equal(recorder.failures.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("leave and re-entry continue after a successful void Leave command", async () => {
  const calls = [];
  const anchor = { page: { id: "anchor" } };
  const remote = { page: { id: "remote" } };
  const state = {
    people: [anchor, remote],
    anchor,
    recorder: {
      async step(label, action) {
        calls.push(label);
        return action();
      },
    },
    snapshot: async (label) => calls.push(label),
  };
  await runLeaveRejoin(state, 1, {
    leaveSpace: async () => calls.push("leave command"),
    assertRoster: async (_page, count) => calls.push(`roster ${count}`),
    reenterParticipant: async () => {
      calls.push("re-enter command");
      return true;
    },
  });
  assert.deepEqual(calls, ["anchor-before-remote-leave-1", "remote leave 1", "leave command", "roster after remote leave 1", "roster 1", "anchor-after-remote-leave-1", "remote rejoin 1", "re-enter command", "roster after remote rejoin 1", "roster 2", "anchor-after-remote-rejoin-1"]);
});

test("run analysis preserves browser-wide trace events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-trace-analysis-test-"));
  try {
    await mkdir(join(directory, "traces"));
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ runId: "trace-test", status: "passed", mode: "shakedown", durationMs: 60_000 }));
    await writeFile(
      join(directory, "traces", "trace-idle-1.json"),
      JSON.stringify({
        feature: "idle",
        durationMs: 1_000,
        browserTrace: {
          counts: { Layout: 4, Paint: 8 },
          durationsMicros: { Layout: 2_000 },
          topFunctions: [{ functionName: "render", url: "/apps/web/src/render.ts", line: 3, calls: 2, durationMicros: 1_000 }],
        },
        participants: [{ participant: "Avery", layerTree: { maxLayerCount: 12, layerPaintEvents: 3, compositingReasons: { video: 2 } } }],
      }),
    );
    const report = await analyzeRun(directory);
    assert.equal(report.traces[0].counts.Layout, 4);
    assert.equal(report.traces[0].counts.Paint, 8);
    assert.equal(report.traces[0].durationPercent.Layout, 0.2);
    assert.equal(report.traces[0].maxLayerCount, 12);
    assert.equal(report.traces[0].topFunctions[0].functionName, "render");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
