import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRunId, measurementPlan, parseCli } from "../config.mjs";
import { browserOptions } from "../cli.mjs";
import { createDiagnosticRecorder, isChatAttachmentExchange, isFatalRequestFailure, isOptionalUiSoundRequest, webSocketCloseFrameDiagnostic, whiteboardControlFrameDiagnostic, whiteboardSocketCloseDiagnostic } from "../browser.mjs";
import { TraceLifecycleError } from "../errors.mjs";
import { aggregateTraceSummaries, analyzeRun, compareReports, summarizeCpuProfile, summarizeMetrics, summarizeProcesses, summarizeSteps } from "../analysis.mjs";
import { deltaSample, diffHeapSummaries, hostLoadSample, sanitizePageUrl } from "../metrics.mjs";
import { assertRemoteCameraState, summarizePeerConnections, waitForChatUploadCompletion } from "../scenario.mjs";
import { summarizeTrace } from "../tracing.mjs";
import { createRecorder, runLeaveRejoin, runScreenShare, shouldContinueCycles, supportFailed } from "../workload.mjs";

test("CLI validates mode duration and Participant limits", () => {
  assert.equal(parseCli(["profile", "--minutes", "30", "--participants", "3", "--base", "http://localhost:13070"]).durationMs, 1_800_000);
  assert.equal(parseCli(["shakedown", "--seconds", "300", "--participants", "4"]).durationMs, 300_000);
  const snapshotPass = parseCli(["shakedown", "--snapshot-pass", "--seconds", "60"]);
  assert.equal(snapshotPass.snapshotPass, true);
  assert.equal(parseCli(["shakedown", "--trace-pass"]).tracePass, true);
  assert.equal(parseCli(["shakedown", "--focus", "leave-rejoin"]).focus, "leave-rejoin");
  assert.equal(parseCli(["shakedown", "--focus", "whiteboard"]).focus, "whiteboard");
  assert.equal(parseCli(["shakedown", "--focus", "media"]).focus, "media");
  assert.throws(() => parseCli(["profile", "--snapshot-pass"]), /only valid for shakedown/);
  assert.throws(() => parseCli(["profile", "--trace-pass"]), /only valid for shakedown/);
  assert.throws(() => parseCli(["shakedown", "--trace-pass", "--snapshot-pass"]), /mutually exclusive/);
  assert.throws(() => parseCli(["profile", "--focus", "leave-rejoin"]), /only valid for shakedown/);
  assert.throws(() => parseCli(["shakedown", "--focus", "unknown"]), /media, leave-rejoin, or whiteboard/);
  assert.throws(() => parseCli(["shakedown", "--focus", "whiteboard", "--trace-pass"]), /cannot be combined/);
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
  assert.deepEqual(measurementPlan(parseCli(["shakedown", "--focus", "leave-rejoin"])), {
    kind: "focused-correctness",
    heapSnapshots: false,
    metricsSampler: false,
    cpuProfiles: false,
    traceRecording: false,
    singleCycle: true,
  });
  assert.equal(shouldContinueCycles(runtimeMeasurement, 0, 1), true);
  assert.equal(shouldContinueCycles(traceMeasurement, 0, 1), false);
  assert.equal(shouldContinueCycles(snapshotMeasurement, 0, 1), false);
});

test("browser launch keeps hardware GPU and fake media while muting physical output", () => {
  const options = browserOptions();
  assert.equal(options.ignoreDefaultArgs.includes("--disable-gpu"), true);
  for (const argument of ["--enable-gpu", "--use-angle=metal", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio"]) {
    assert.equal(options.args.includes(argument), true);
  }
});

function cameraVideo(frames) {
  const callbacks = [];
  const track = { kind: "video", readyState: "live" };
  const stream = { getVideoTracks: () => [track] };
  const video = {
    srcObject: stream,
    classList: { contains: (className) => className === "opacity-100" },
    readyState: 2,
    paused: false,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: frames.value }),
    requestVideoFrameCallback: (callback) => callbacks.push(callback),
  };
  return { callbacks, frames, stream, track, video };
}

function cameraPage(state, onTick) {
  let now = 0;
  let tick = 0;
  const tile = {
    getAttribute: (attribute) => (attribute === "aria-label" ? "Video tile for Blake" : null),
    querySelector: () => state.current?.video ?? null,
  };
  const globals = {
    document: { querySelectorAll: () => [tile] },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    performance: { now: () => now },
    window: {
      setTimeout: (resolve) => {
        tick += 1;
        onTick(tick);
        now += 1_000;
        resolve();
      },
    },
  };
  return {
    evaluate: async (callback, argumentsObject) => {
      const previous = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
      try {
        for (const [name, value] of Object.entries(globals)) globalThis[name] = value;
        return await callback(argumentsObject);
      } finally {
        for (const [name, descriptor] of previous) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else delete globalThis[name];
        }
      }
    },
  };
}

test("remote camera proof reacquires a replacement after temporary disappearance and resets its frame baseline", async () => {
  const first = cameraVideo({ value: 8 });
  const replacement = cameraVideo({ value: 1 });
  const state = { current: first };
  const page = cameraPage(state, (tick) => {
    if (tick === 1) state.current = null;
    if (tick === 2) state.current = replacement;
    if (tick === 3) replacement.frames.value = 2;
  });

  await assertRemoteCameraState(page, "Blake", true);
});

test("remote camera proof ignores a frame callback from a replaced publication", async () => {
  const first = cameraVideo({ value: 1 });
  const replacement = cameraVideo({ value: 1 });
  const state = { current: first };
  const page = cameraPage(state, (tick) => {
    if (tick !== 1) return;
    state.current = replacement;
    for (const callback of first.callbacks.splice(0)) callback();
  });

  await assert.rejects(assertRemoteCameraState(page, "Blake", true), /did not produce a decoded frame/);
});

test("WebRTC summary helper returns a bounded unavailable result without the harness override", async () => {
  const summary = await summarizePeerConnections({ evaluate: async (callback) => callback() });
  assert.deepEqual(summary, { maxPeerConnections: 0, peerConnections: [], unavailable: true });
});

test("chat upload completion distinguishes sent attachments from composer failures", async () => {
  const unresolved = () => new Promise(() => {});
  await waitForChatUploadCompletion({ waitFor: async () => {} }, { waitFor: unresolved }, 1);
  await assert.rejects(waitForChatUploadCompletion({ waitFor: unresolved }, { waitFor: async () => {}, textContent: async () => "  Attachment upload failed with HTTP 403  " }, 1), /chat file upload failed: Attachment upload failed with HTTP 403/);
});

test("run identifiers remain unique and filesystem-safe", () => {
  const id = createRunId(new Date("2026-08-23T12:34:56.789Z"), 0);
  assert.match(id, /^2026-08-23T12-34-56-789Z-000000$/);
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

test("chat attachment diagnostics select initiation, storage PUT, and finalize exchanges", () => {
  assert.equal(isChatAttachmentExchange("POST", "http://127.0.0.1:18080/v1/chat/attachments/uploads"), true);
  assert.equal(isChatAttachmentExchange("PUT", "http://127.0.0.1:19000/bucket/key?X-Amz-Signature=secret"), true);
  assert.equal(isChatAttachmentExchange("POST", "http://127.0.0.1:18080/v1/chat/attachments/uploads/upload-1/finalize"), true);
  assert.equal(isChatAttachmentExchange("GET", "http://127.0.0.1:18080/v1/chat/attachments/uploads"), false);
  assert.equal(isChatAttachmentExchange("POST", "http://127.0.0.1:18080/v1/spaces"), false);
  assert.equal(isChatAttachmentExchange("PUT", "http://127.0.0.1:18080/v1/tenants/t/episodes/e/participants/p/media/sfu/tracks/close"), false);
});

test("optional Chalk UI join and leave sounds are nonfatal browser media", () => {
  assert.equal(isOptionalUiSoundRequest("media", "https://assets.chalkmeet.com/ui/sounds/join.dbf745b208f0.opus"), true);
  assert.equal(isOptionalUiSoundRequest("media", "https://assets.chalkmeet.com/ui/sounds/leave.dbf745b208f0.opus"), true);
  assert.equal(isOptionalUiSoundRequest("script", "https://assets.chalkmeet.com/ui/sounds/join.dbf745b208f0.opus"), false);
  assert.equal(isOptionalUiSoundRequest("media", "https://example.com/ui/sounds/join.dbf745b208f0.opus"), false);
});

test("unrelated media request failures remain fatal", () => {
  const dnsFailure = "net::ERR_NAME_NOT_RESOLVED";
  assert.equal(isFatalRequestFailure(dnsFailure, "media", "https://assets.chalkmeet.com/ui/sounds/leave.dbf745b208f0.opus"), false);
  assert.equal(isFatalRequestFailure(dnsFailure, "media", "https://assets.chalkmeet.com/ui/video/preview.dbf745b208f0.mp4"), true);
});

test("whiteboard control diagnostics retain presentation causality without operation identifiers", () => {
  const operations = new Map();
  assert.equal(whiteboardControlFrameDiagnostic("sent", JSON.stringify({ type: "set_presentation", operation_id: "secret-operation", presenting: false }), operations), "sent set_presentation false");
  assert.equal(whiteboardControlFrameDiagnostic("received", JSON.stringify({ type: "commit", operation_id: "secret-operation", outcome: "committed", scene_id: "secret-scene", revision: "7" }), operations), "received set_presentation commit false");
  assert.equal(operations.size, 0);
  assert.equal(whiteboardControlFrameDiagnostic("received", JSON.stringify({ type: "presentation_updated", scene_id: "secret-scene", revision: "7", presenting: false }), operations), "received presentation_updated false");
  assert.equal(whiteboardControlFrameDiagnostic("received", JSON.stringify({ type: "reset_required", scene_id: "secret-scene", reason: "gap" }), operations), "received reset_required gap");
  assert.equal(whiteboardControlFrameDiagnostic("received", JSON.stringify({ type: "welcome", presenting: true }), operations), "received welcome presentation true");
  assert.equal(whiteboardControlFrameDiagnostic("sent", JSON.stringify({ type: "submit_update", operation_id: "secret-update" }), operations), "sent submit_update");
  assert.equal(whiteboardControlFrameDiagnostic("sent", JSON.stringify({ type: "snapshot_ack", request_id: "secret-request", page: 0 }), operations), "sent snapshot_ack");
  assert.equal(whiteboardControlFrameDiagnostic("received", JSON.stringify({ type: "snapshot_page", request_id: "secret-request", page: 0 }), operations), "received snapshot_page");
});

test("WebSocket close-frame diagnostics retain status and reason", () => {
  const closePayload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("whiteboard subscription stopped")]).toString("base64");
  assert.equal(webSocketCloseFrameDiagnostic("sent", closePayload), "sent close frame 1000 whiteboard subscription stopped");
  assert.equal(webSocketCloseFrameDiagnostic("received", ""), "received close frame without status");
  assert.equal(webSocketCloseFrameDiagnostic("received", Buffer.from([0x03]).toString("base64")), "received malformed close frame");
  assert.equal(whiteboardSocketCloseDiagnostic(1008, "operation not available in this phase", true), "WebSocket closed 1008 operation not available in this phase; clean=true");
});

test("metric page URLs omit invite tokens", () => {
  assert.equal(sanitizePageUrl("http://127.0.0.1:13070/space/public-id?name=Avery#spaceInviteToken=secret"), "http://127.0.0.1:13070/space/public-id");
});

test("host load samples and summaries expose shared-host contention", () => {
  assert.deepEqual(hostLoadSample([2, 3, 4], 10), { hostLoad1m: 2, hostLoad5m: 3, hostLoad15m: 4, hostAvailableParallelism: 10 });
  const report = summarizeMetrics([
    { kind: "drift", driftMs: 1, hostLoad1m: 2, hostLoad5m: 3, hostLoad15m: 4, hostAvailableParallelism: 10 },
    { kind: "drift", driftMs: 2, hostLoad1m: 6, hostLoad5m: 5, hostLoad15m: 4.5, hostAvailableParallelism: 10 },
  ]);
  assert.deepEqual(report.host, { sampleCount: 2, availableParallelism: 10, averageLoad1m: 4, maxLoad1m: 6, maxLoad5m: 5, maxLoad15m: 4.5 });
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

test("only a strict feature failure suppresses later workload attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-recorder-support-test-"));
  try {
    const recorder = createRecorder(directory);
    assert.equal(supportFailed(recorder, "camera-video"), false);
    recorder.updateSupport("camera-video", "unreachable", { reason: "not exposed" });
    assert.equal(supportFailed(recorder, "camera-video"), false);
    recorder.updateSupport("camera-video", "failed", { reason: "timeout" });
    assert.equal(supportFailed(recorder, "camera-video"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function screenShareHarness() {
  const anchor = { page: { id: "anchor" } };
  const remote = { name: "Blake", page: { id: "remote" } };
  const traceFeatures = [];
  const stepFailures = [];
  const state = {
    people: [anchor, remote],
    anchor,
    recorder: {
      supportStatus: () => null,
      async step(label, action) {
        try {
          return await action();
        } catch (error) {
          stepFailures.push({ label, error });
          return null;
        }
      },
    },
    trace: async (feature, cycle, action) => {
      traceFeatures.push({ feature, cycle });
      await action();
    },
  };
  return { remote, state, stepFailures, traceFeatures };
}

test("screen share visibility failure stops the active share and preserves cleanup failure", async () => {
  const primaryError = new Error("remote share was not visible");
  const cleanupError = new Error("remote share stayed visible during cleanup");
  const assertions = [];
  let toggleCalls = 0;
  const harness = screenShareHarness();
  await runScreenShare(harness.state, 1, {
    assertRemoteShare: async (_page, _name, active) => {
      assertions.push(active);
      if (active) throw primaryError;
      throw cleanupError;
    },
    screenShareFailureDetail: async () => "screen share detail",
    toggleScreenShare: async () => {
      toggleCalls += 1;
      return toggleCalls === 1;
    },
    wait: async () => {},
    zoomPanScreenShare: async () => {},
  });
  assert.equal(toggleCalls, 2);
  assert.deepEqual(assertions, [true, false]);
  assert.deepEqual(harness.traceFeatures, [{ feature: "screen-share-video", cycle: 1 }]);
  assert.equal(harness.stepFailures.length, 1);
  assert.ok(harness.stepFailures[0].error instanceof AggregateError);
  assert.deepEqual(harness.stepFailures[0].error.errors, [primaryError, cleanupError]);
});

test("screen share zoom failure stops the active share without adding a stop trace", async () => {
  const primaryError = new Error("screen share zoom failed");
  const assertions = [];
  let toggleCalls = 0;
  const harness = screenShareHarness();
  await runScreenShare(harness.state, 1, {
    assertRemoteShare: async (_page, _name, active) => assertions.push(active),
    screenShareFailureDetail: async () => "screen share detail",
    toggleScreenShare: async () => {
      toggleCalls += 1;
      return toggleCalls === 1;
    },
    wait: async () => {},
    zoomPanScreenShare: async () => {
      throw primaryError;
    },
  });
  assert.equal(toggleCalls, 2);
  assert.deepEqual(assertions, [true, false]);
  assert.deepEqual(harness.traceFeatures, [
    { feature: "screen-share-video", cycle: 1 },
    { feature: "screen-share-zoom-pan", cycle: 1 },
  ]);
  assert.equal(harness.stepFailures.length, 1);
  assert.equal(harness.stepFailures[0].error, primaryError);
});

test("screen share success stops once after both measured traces", async () => {
  const assertions = [];
  let toggleCalls = 0;
  const harness = screenShareHarness();
  await runScreenShare(harness.state, 1, {
    assertRemoteShare: async (_page, _name, active) => assertions.push(active),
    screenShareFailureDetail: async () => "screen share detail",
    toggleScreenShare: async () => {
      toggleCalls += 1;
      return toggleCalls === 1;
    },
    wait: async () => {},
    zoomPanScreenShare: async () => {},
  });
  assert.equal(toggleCalls, 2);
  assert.deepEqual(assertions, [true, false]);
  assert.deepEqual(harness.traceFeatures, [
    { feature: "screen-share-video", cycle: 1 },
    { feature: "screen-share-zoom-pan", cycle: 1 },
  ]);
  assert.equal(harness.stepFailures.length, 0);
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
