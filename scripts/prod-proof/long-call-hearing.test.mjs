import assert from "node:assert/strict";
import test from "node:test";
import { judgeLongCall } from "./long-call-criteria.mjs";
import { healthyCall, heardEveryUnmute, judged } from "./long-call-criteria-test-support.mjs";

test("a microphone that turned back on and was not decoded by another guest fails, though its bytes kept advancing", () => {
  const call = healthyCall();
  // Guest 3 is deaf to guest 2 after guest 2's turn-on at +36 s: the healthy samples keep every counter climbing, so only the decoded tone says so.
  const toggle = call.toggles.find((entry) => entry.guest === 1 && entry.kind === "microphone" && entry.enabled);
  const hearings = heardEveryUnmute(call).map((hearing) => (hearing.speaker === 1 && hearing.atMs === toggle.atMs ? { ...hearing, verdicts: hearing.verdicts.map((verdict) => (verdict.listener === 3 ? { ...verdict, pass: false, peakDb: -140, bin: 76, floorDb: -140 } : verdict)) } : hearing));
  assert.deepEqual(judged({ ...call, hearings }), ["Guest 3 did not decode guest 2 within 5 s of its microphone turning back on (-140 dB at bin 76, floor -140 dB); turned back on at +36s"]);
});

test("a microphone muted again inside the hearing window is not judged for being heard", () => {
  const base = healthyCall();
  const toggles = [...base.toggles, { atMs: 101_000, guest: 2, kind: "microphone", enabled: false }, { atMs: 103_000, guest: 2, kind: "microphone", enabled: true }, { atMs: 105_000, guest: 2, kind: "microphone", enabled: false }];
  const call = { ...base, toggles };
  const hearings = heardEveryUnmute(base);
  assert.deepEqual(judged({ ...call, hearings }), [], "the 2 s span has no hearing and no failure");
  const longer = { ...call, toggles: toggles.slice(0, -1) };
  assert.deepEqual(judged({ ...longer, hearings }), ["Guest 3's microphone turned back on at +103s was never checked for being heard"], "a span that stays on is still checked");
});

test("every microphone turn-on must be checked at every other guest, by every guest that turns one on", () => {
  const call = healthyCall();
  const turnOns = call.toggles.filter((entry) => entry.kind === "microphone" && entry.enabled);
  assert.deepEqual([...new Set(turnOns.map((entry) => entry.guest))], [0, 1, 2], "every guest re-publishes its microphone around a refresh");
  const all = heardEveryUnmute(call);
  const unchecked = all.filter((hearing) => !(hearing.speaker === 1 && hearing.atMs === turnOns.find((entry) => entry.guest === 1).atMs));
  assert.deepEqual(judged({ ...call, hearings: unchecked }), ["Guest 2's microphone turned back on at +36s was never checked for being heard"]);
  const partial = all.map((hearing) => (hearing.speaker === 0 && hearing.atMs === turnOns[0].atMs ? { ...hearing, verdicts: hearing.verdicts.slice(1) } : hearing));
  assert.deepEqual(judged({ ...call, hearings: partial }), ["Guest 1's microphone turned back on at +26s was checked at 1 of 2 other guests"]);
  assert.deepEqual(judged({ ...call, hearings: all }), []);
});

test("a listener page that closed during the hearing check fails the call naming the listener", () => {
  const call = healthyCall();
  const toggle = call.toggles.find((entry) => entry.guest === 0 && entry.kind === "microphone" && entry.enabled);
  const hearings = heardEveryUnmute(call).map((hearing) =>
    hearing.speaker === 0 && hearing.atMs === toggle.atMs ? { ...hearing, verdicts: hearing.verdicts.map((verdict) => (verdict.listener === 2 ? { listener: 2, speaker: 1, pass: false, why: "the listener's page failed: Target page, context or browser has been closed" } : verdict)) } : hearing,
  );
  assert.deepEqual(judged({ ...call, hearings }), ["Guest 2 did not decode guest 1 within 5 s of its microphone turning back on (the listener's page failed: Target page, context or browser has been closed); turned back on at +26s"]);
});
