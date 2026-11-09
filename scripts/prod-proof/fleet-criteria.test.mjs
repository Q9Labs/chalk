import assert from "node:assert/strict";
import test from "node:test";
import { callHours, finding, foreignParticipants, leakedSources, missingSources, stalledSources, summarizeFleet, wantsMoreCalls } from "./fleet-criteria.mjs";

const row = (participantId, source, kind, counters, key = `0:${participantId}${source}`) => ({ key, participantId, source, kind, bytes: 0, frames: 0, energy: 0, ...counters });
const page = (self, rows, extra = {}) => ({ at: 0, self, roster: ["a", "b"], remote: [], rows, ...extra });
const both = { a: { microphone: true, camera: true, screen: false }, b: { microphone: true, camera: true, screen: false } };

test("a call has rendered when every other guest's microphone moved bytes and its camera decoded a frame", () => {
  const empty = page("a", []);
  assert.deepEqual(missingSources(empty, both), [
    ["b", "microphone", "audio"],
    ["b", "camera", "video"],
  ]);
  const full = page("a", [row("b", "microphone", "audio", { bytes: 90 }), row("b", "camera", "video", { frames: 1 })]);
  assert.deepEqual(missingSources(full, both), []);
});

test("a muted microphone is not expected, a screen share is once it is on", () => {
  const state = { a: both.a, b: { microphone: false, camera: true, screen: true } };
  const sample = page("a", [row("b", "camera", "video", { frames: 3 })]);
  assert.deepEqual(missingSources(sample, state), [["b", "screen", "video"]]);
});

test("a source is stalled when its counters stay the same, or when it is new between two samples", () => {
  const before = page("a", [row("b", "microphone", "audio", { bytes: 10 }), row("b", "camera", "video", { frames: 5 })]);
  const moving = page("a", [row("b", "microphone", "audio", { bytes: 20 }), row("b", "camera", "video", { frames: 9 })]);
  const frozen = page("a", [row("b", "microphone", "audio", { bytes: 20 }), row("b", "camera", "video", { frames: 5 })]);
  const replaced = page("a", [row("b", "microphone", "audio", { bytes: 20 }, "1:new"), row("b", "camera", "video", { frames: 9 }, "1:cam")]);
  assert.deepEqual(stalledSources(before, moving, both), []);
  assert.deepEqual(stalledSources(before, frozen, both), [["b", "camera", "video"]]);
  assert.equal(stalledSources(before, replaced, both).length, 2);
});

test("a muted microphone leaks when audio keeps arriving faster than comfort noise", () => {
  const before = page("a", [row("b", "microphone", "audio", { bytes: 1000 })], { at: 0 });
  const later = (bytes, at = 1000) => page("a", [row("b", "microphone", "audio", { bytes })], { at });
  assert.deepEqual(leakedSources(before, later(1400), "b", ["microphone"]), []);
  assert.deepEqual(leakedSources(before, later(5000), "b", ["microphone"]), ["microphone"]);
  assert.deepEqual(leakedSources(before, later(5000, 4000), "b", ["microphone"]), []);
  assert.deepEqual(leakedSources(before, page("a", [], { at: 1000 }), "b", ["microphone"]), []);
});

test("a camera that is off leaks when frames keep decoding", () => {
  const before = page("a", [row("b", "camera", "video", { frames: 10 })]);
  assert.deepEqual(leakedSources(before, page("a", [row("b", "camera", "video", { frames: 40 })]), "b", ["camera"]), ["camera"]);
  assert.deepEqual(leakedSources(before, page("a", [row("b", "camera", "video", { frames: 10 })]), "b", ["camera"]), []);
});

test("a participant outside the call is reported wherever the page sees it", () => {
  const sample = page("a", [row("x", "camera", "video", {})], { roster: ["a", "b", "y"], remote: [{ participantId: "z", source: "camera" }] });
  assert.deepEqual(foreignParticipants(sample, ["a", "b"]).sort(), ["x", "y", "z"]);
  assert.deepEqual(foreignParticipants(page("a", []), ["a", "b"]), []);
});

const record = (id, extra = {}) => ({ id, guests: 3, renderedAt: 0, endedAt: 3_600_000, joinMs: 2000, faults: [], findings: [], ...extra });

test("call-hours run from every guest rendering to the end; a call that never rendered counts none", () => {
  assert.equal(callHours(record("a")), 1);
  assert.equal(callHours(record("b", { renderedAt: undefined })), 0);
});

test("the summary counts calls, call-hours, fault trials and P1 findings and fails on any P1", () => {
  const p1 = record("c", { findings: [finding("mute_leak", "x")], faults: [{ ms: 4000 }] });
  const summary = summarizeFleet([record("a", { faults: [{ ms: 1000 }, { ms: 3000 }] }), record("b"), p1]);
  assert.equal(summary.calls, 3);
  assert.equal(summary.callHours, 3);
  assert.equal(summary.participantHours, 9);
  assert.equal(summary.faultTrials, 3);
  assert.equal(summary.p1, 1);
  assert.deepEqual(summary.findings, { mute_leak: 1 });
  assert.equal(summary.recovery.maxMs, 4000);
  assert.equal(summary.result, "failed");
  assert.equal(summary.meetsVolumeExit, false);
});

test("a non-P1 finding or an errored call fails the run without counting as a P1", () => {
  const summary = summarizeFleet([record("a", { findings: [finding("action_failed", "x")] }), record("b", { error: "boom" })]);
  assert.equal(summary.p1, 0);
  assert.equal(summary.erroredCalls, 1);
  assert.equal(summary.result, "failed");
});

test("the volume exit needs 200 calls and 50 call-hours", () => {
  const calls = Array.from({ length: 200 }, (_, index) => record(String(index), { endedAt: 900_000 }));
  assert.equal(summarizeFleet(calls).callHours, 50);
  assert.equal(summarizeFleet(calls).meetsVolumeExit, true);
  assert.equal(summarizeFleet(calls.slice(1)).meetsVolumeExit, false);
});

test("the scheduler stops for a P1 only when asked to, and counts running calls toward the targets", () => {
  const targets = { calls: 4, callHours: 1 };
  assert.equal(wantsMoreCalls({ started: 3, doneHours: 0, runningHours: 0, p1: 0 }, targets, true), true);
  assert.equal(wantsMoreCalls({ started: 4, doneHours: 0.5, runningHours: 0.5, p1: 0 }, targets, true), false);
  assert.equal(wantsMoreCalls({ started: 4, doneHours: 0.5, runningHours: 0.2, p1: 0 }, targets, true), true);
  assert.equal(wantsMoreCalls({ started: 1, doneHours: 0, runningHours: 0, p1: 1 }, targets, true), false);
  assert.equal(wantsMoreCalls({ started: 1, doneHours: 0, runningHours: 0, p1: 1 }, targets, false), true);
});
