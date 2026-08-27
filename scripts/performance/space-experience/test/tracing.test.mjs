import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { cpuProfileFilePath, startParticipantCpuProfiles, stopParticipantCpuProfiles, summarizeParticipantCpuProfileCoverage, validateGpuSystemInfo } from "../cli.mjs";
import { TraceLifecycleError } from "../errors.mjs";
import { createTraceRecorder, summarizeTrace, traceFeature } from "../tracing.mjs";

class FakeCdp extends EventEmitter {
  constructor({ layerEnableError = null, layerEnableDelayMs = 0, traceStartError = null, traceEndDelayMs = 0, complete = true, traceStream = null, traceStreamBase64 = false, traceChunkSize = Number.POSITIVE_INFINITY, traceChunkBytes = false, readError = null, closeError = null } = {}) {
    super();
    this.calls = [];
    this.layerEnableError = layerEnableError;
    this.layerEnableDelayMs = layerEnableDelayMs;
    this.traceStartError = traceStartError;
    this.traceEndDelayMs = traceEndDelayMs;
    this.complete = complete;
    this.traceStream =
      traceStream ??
      JSON.stringify({
        traceEvents: [
          { name: "Paint", dur: 10 },
          { name: "FunctionCall", dur: 5, args: { data: { functionName: "draw", url: "/app.js", lineNumber: 4 } } },
        ],
      });
    this.traceBuffer = Buffer.from(this.traceStream);
    this.traceStreamBase64 = traceStreamBase64;
    this.traceChunkSize = traceChunkSize;
    this.traceChunkBytes = traceChunkBytes;
    this.readError = readError;
    this.closeError = closeError;
    this.traceOffset = 0;
  }

  async send(command, params) {
    this.calls.push({ command, params });
    if (command === "LayerTree.enable" && this.layerEnableError) throw this.layerEnableError;
    if (command === "Tracing.start" && this.traceStartError) throw this.traceStartError;
    if (command === "LayerTree.enable") {
      if (this.layerEnableDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.layerEnableDelayMs));
      queueMicrotask(() => {
        this.emit("LayerTree.layerTreeDidChange", { layers: [{ layerId: "layer-1", drawsContent: true }] });
        this.emit("LayerTree.layerPainted", { layerId: "layer-1" });
      });
    }
    if (command === "Tracing.start") {
      queueMicrotask(() => {
        this.emit("Tracing.dataCollected", {
          value: [
            { name: "Paint", dur: 10 },
            { name: "FunctionCall", dur: 5, args: { data: { functionName: "draw", url: "/app.js", lineNumber: 4 } } },
          ],
        });
      });
    }
    if (command === "Tracing.end") {
      if (this.traceEndDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.traceEndDelayMs));
      if (this.complete) queueMicrotask(() => this.emit("Tracing.tracingComplete", { stream: "trace-stream" }));
    }
    if (command === "IO.read") {
      if (this.readError) throw this.readError;
      if (this.traceChunkBytes) {
        const chunk = this.traceBuffer.subarray(this.traceOffset, this.traceOffset + this.traceChunkSize);
        this.traceOffset += chunk.length;
        return {
          data: this.traceStreamBase64 ? chunk.toString("base64") : chunk.toString("utf8"),
          eof: this.traceOffset >= this.traceBuffer.length,
          base64Encoded: this.traceStreamBase64,
        };
      }
      const chunk = this.traceStream.slice(this.traceOffset, this.traceOffset + this.traceChunkSize);
      this.traceOffset += chunk.length;
      return {
        data: this.traceStreamBase64 ? Buffer.from(chunk).toString("base64") : chunk,
        eof: this.traceOffset >= this.traceStream.length,
        base64Encoded: this.traceStreamBase64,
      };
    }
    if (command === "IO.close") {
      if (this.closeError) throw this.closeError;
      return {};
    }
    if (command === "LayerTree.compositingReasons") return { compositingReasons: ["will-change-transform"] };
    return {};
  }

  count(command) {
    return this.calls.filter((call) => call.command === command).length;
  }
}

function participants(count, options = {}) {
  return Array.from({ length: count }, (_, index) => ({ name: `Participant-${index + 1}`, index, cdp: new FakeCdp(options) }));
}

async function withOutput(callback) {
  const directory = await mkdtemp(join(tmpdir(), "chalk-trace-test-"));
  try {
    return await callback(join(directory, "trace.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function browserCdp(options) {
  return new FakeCdp(options);
}

function assertLayersDisabled(people) {
  assert.deepEqual(
    people.map((person) => person.cdp.count("LayerTree.disable")),
    [1, 1],
  );
}

test("uses one browser Tracing start/end and one LayerTree recorder", async () => {
  await withOutput(async (outputPath) => {
    const people = participants(1);
    const browser = browserCdp();
    const record = await traceFeature({ participants: people, browserCdp: browser, feature: "single", action: () => {}, outputPath, observeMs: 0 });
    assert.equal(browser.count("Tracing.start"), 1);
    assert.equal(browser.calls.find((call) => call.command === "Tracing.start").params.transferMode, "ReturnAsStream");
    assert.equal(browser.count("Tracing.end"), 1);
    assert.equal(people[0].cdp.count("LayerTree.enable"), 1);
    assert.equal(people[0].cdp.count("LayerTree.disable"), 1);
    assert.equal(record.participants[0].counts, undefined);
    assert.equal(record.browserTrace.counts.Paint, 1);
    assert.equal(record.participants[0].layerTree.layerPaintEvents, 1);
    const summary = summarizeTrace(record);
    assert.equal(summary.counts.Paint, 1);
    const expectedRate = record.durationMs > 0 ? summary.counts.Paint / ((record.durationMs * record.participants.length) / 1_000) : null;
    assert.equal(summary.countsPerParticipantSecond.Paint, expectedRate);
  });
});

test("drains traces larger than the JavaScript argument limit", async () => {
  await withOutput(async (outputPath) => {
    const eventCount = 150_000;
    const traceStream = JSON.stringify({ traceEvents: Array.from({ length: eventCount }, () => ({ name: "Paint", dur: 1 })) });
    const record = await traceFeature({ participants: participants(1), browserCdp: browserCdp({ traceStream }), feature: "large-stream", action: () => {}, outputPath, observeMs: 0 });
    assert.equal(record.browserTrace.eventCount, eventCount);
    assert.equal(record.browserTrace.counts.Paint, eventCount);
  });
});

test("start and stop overlap finish once without a promise cycle", async () => {
  const people = participants(2, { layerEnableDelayMs: 10 });
  const browser = browserCdp();
  const recorder = createTraceRecorder({ browserCdp: browser, participants: people, traceCompleteTimeoutMs: 100 });
  const startPromise = recorder.start();
  const stopPromise = recorder.stop();
  const [startResult, stopResult] = await Promise.all([startPromise, stopPromise]);
  assert.equal(startResult, undefined);
  assert.equal(stopResult.browserTrace.counts.Paint, 1);
  assert.equal(browser.count("Tracing.start"), 1);
  assert.equal(browser.count("Tracing.end"), 1);
  assertLayersDisabled(people);
  recorder.dispose();
});

test("writes an analyzable artifact and cleans up when the action throws", async () => {
  await withOutput(async (outputPath) => {
    const people = participants(2);
    const browser = browserCdp();
    await assert.rejects(
      () =>
        traceFeature({
          participants: people,
          browserCdp: browser,
          feature: "action-failure",
          action: () => {
            throw new Error("action broke");
          },
          outputPath,
          observeMs: 0,
        }),
      /action broke/,
    );
    const artifact = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(artifact.errors[0].phase, "action");
    assert.equal(browser.count("Tracing.end"), 1);
    assertLayersDisabled(people);
    assert.equal(artifact.participants.length, 2);
  });
});

test("rolls back already-enabled layers when a later page fails to start", async () => {
  await withOutput(async (outputPath) => {
    const people = participants(3);
    people[1].cdp.layerEnableError = new Error("page layer failed");
    const browser = browserCdp();
    await assert.rejects(() => traceFeature({ participants: people, browserCdp: browser, feature: "layer-start-failure", action: () => {}, outputPath, observeMs: 0 }), /page layer failed/);
    assert.equal(browser.count("Tracing.start"), 0);
    assert.equal(browser.count("Tracing.end"), 0);
    assert.equal(people[0].cdp.count("LayerTree.disable"), 1);
    assert.equal(people[1].cdp.count("LayerTree.disable"), 0);
    const artifact = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(artifact.errors[0].phase, "start");
  });
});

test("bounds tracingComplete wait, writes the partial trace, and disables layers", async () => {
  await withOutput(async (outputPath) => {
    const people = participants(2);
    const browser = browserCdp({ complete: false });
    const startedAt = Date.now();
    await assert.rejects(() => traceFeature({ participants: people, browserCdp: browser, feature: "completion-timeout", action: () => {}, outputPath, observeMs: 0, traceCompleteTimeoutMs: 10 }), /timed out/);
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(browser.count("Tracing.end"), 1);
    assertLayersDisabled(people);
    const artifact = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(artifact.errors[0].phase, "stop");
    assert.equal(artifact.browserTrace.counts.Paint, 1);
  });
});

test("rejects software GPU system info before a profile starts", () => {
  assert.throws(() => validateGpuSystemInfo({ gpu: { featureStatus: { gpu_compositing: "disabled_software" }, auxAttributes: { glRenderer: "ANGLE (SwiftShader)" } } }), /GPU compositing is disabled_software/);
  assert.throws(() => validateGpuSystemInfo({ gpu: { featureStatus: { gpu_compositing: "enabled" }, auxAttributes: { glRenderer: "ANGLE (SwiftShader)" } } }), /SwiftShader/);
  assert.doesNotThrow(() => validateGpuSystemInfo({ gpu: { featureStatus: { gpu_compositing: "enabled" }, auxAttributes: { glRenderer: "ANGLE Metal Renderer" } } }));
});

test("profiles every Participant and cleans up only started profiles after partial startup", async () => {
  const people = participants(3);
  const started = [];
  let states;
  try {
    await startParticipantCpuProfiles(people, {
      start: async (cdp) => {
        started.push(cdp);
        if (cdp === people[1].cdp) throw new Error("remote profiler rejected");
      },
    });
    assert.fail("CPU profile startup should reject");
  } catch (error) {
    assert.match(error.message, /CPU profile start failed for Participant-2/);
    states = error.profileStates;
  }
  assert.deepEqual(started, [people[0].cdp, people[1].cdp]);
  assert.deepEqual(
    states.map((state) => state.started),
    [true, false, false],
  );

  const stopped = [];
  const result = await stopParticipantCpuProfiles(states, "/tmp/chalk-trace-profile-test", {
    stop: async (cdp, filePath) => {
      stopped.push({ cdp, filePath });
      return { file: filePath, samples: 1 };
    },
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.summaries.length, 1);
  assert.equal(result.summaries[0].participant, "Participant-1");
  assert.equal(stopped[0].filePath, cpuProfileFilePath("/tmp/chalk-trace-profile-test", people[0]));
  assert.notEqual(cpuProfileFilePath("/tmp/chalk-trace-profile-test", people[0]), cpuProfileFilePath("/tmp/chalk-trace-profile-test", people[1]));
});

test("rejects CPU profile sets with a truncated Participant profile", () => {
  const people = [
    { name: "Avery", index: 0 },
    { name: "Blake", index: 1 },
    { name: "Casey", index: 2 },
  ];
  const complete = summarizeParticipantCpuProfileCoverage(
    [
      { participant: "Avery", participantIndex: 0, durationUs: 100_000_000 },
      { participant: "Blake", participantIndex: 1, durationUs: 99_000_000 },
      { participant: "Casey", participantIndex: 2, durationUs: 98_000_000 },
    ],
    people,
  );
  assert.equal(complete.valid, true);

  const truncated = summarizeParticipantCpuProfileCoverage(
    [
      { participant: "Avery", participantIndex: 0, durationUs: 100_000_000 },
      { participant: "Blake", participantIndex: 1, durationUs: 15_000_000 },
    ],
    people,
  );
  assert.equal(truncated.valid, false);
  assert.deepEqual(truncated.missing, [{ participant: "Casey", participantIndex: 2 }]);
  assert.equal(truncated.durationRatio, 0.15);
});
