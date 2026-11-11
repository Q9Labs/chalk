import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessLifetimeMs, bounds, callDurationMs, evidenceLine, judgeLongCall, planRefreshToggles, refreshIntervalMs, refreshToggles, refreshWindowMs, toggleSchedule, unreachableSample } from "./long-call-criteria.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const startedAtMs = Date.parse("2026-11-10T02:00:00Z");
const participants = ["p1", "p2", "p3"];

/** A grant request `atMs` into the call; the grant it returns lives one access lifetime. */
const grant = (atMs, { replace = false } = {}) => ({
  status: 201,
  reason: replace ? "retry" : "refresh", // the names the proof records
  replaceMediaConnection: replace,
  startedAt: new Date(startedAtMs + atMs).toISOString(),
  mediaExpiry: startedAtMs + atMs + accessLifetimeMs,
});
const guestWith = (index, requests) => ({ guest: index + 1, initialExpiry: startedAtMs + accessLifetimeMs, requests });

/** A healthy call, sampled like the proof does: a counter climbs while its source is on and restarts after each toggle. */
function healthyCall({ durationMs = callDurationMs, toggles = toggleSchedule(), participants: guestParticipants = participants } = {}) {
  const counters = guestParticipants.map(() => ({ mic: 0, camera: 0 }));
  const ticks = [];
  for (let at = 0; at <= durationMs; at += bounds.sampleIntervalMs) {
    const on = guestParticipants.map((_, guest) => {
      const state = { mic: true, camera: true };
      for (const toggle of toggles.filter((entry) => entry.guest === guest && entry.atMs <= at)) state[toggle.kind === "microphone" ? "mic" : "camera"] = toggle.enabled;
      return state;
    });
    guestParticipants.forEach((_, guest) => {
      for (const kind of ["mic", "camera"]) counters[guest][kind] = on[guest][kind] ? counters[guest][kind] + 5000 : 0;
    });
    ticks.push({
      t: startedAtMs + at,
      guests: guestParticipants.map((_, guest) => ({
        reachable: true,
        status: "live",
        errorCode: null,
        mic: on[guest].mic,
        camera: on[guest].camera,
        pcs: ["closed", "connected"],
        outAudio: counters[guest].mic,
        remotes: guestParticipants.flatMap((id, sender) =>
          sender === guest
            ? []
            : [
                ["microphone", "mic"],
                ["camera", "camera"],
              ]
                .filter(([, flag]) => on[sender][flag])
                .map(([source, flag]) => ({ participantId: id, source, bytes: counters[sender][flag] })),
        ),
      })),
    });
  }
  const refreshes = guestParticipants.map((_, index) => guestWith(index, [grant(refreshIntervalMs), grant(2 * refreshIntervalMs)]));
  return { ticks, participants: guestParticipants, refreshes, toggles, startedAtMs };
}
/** What every other guest decoded after each microphone turn-on in a healthy call: a passing verdict for each listener. */
const heardEveryUnmute = ({ toggles, participants: guestParticipants }) =>
  toggles
    .filter((toggle) => toggle.kind === "microphone" && toggle.enabled)
    .map(({ guest, atMs }) => ({ speaker: guest, atMs, verdicts: guestParticipants.flatMap((_, listener) => (listener === guest ? [] : [{ listener: listener + 1, speaker: guest + 1, pass: true, peakDb: -25, bin: 38, floorDb: -90 }])) }));
const judge = (call) => judgeLongCall({ hearings: heardEveryUnmute(call), ...call });
const judged = (call) => judge(call).failures;
const replacedMedia = (failure) => failure.includes("replaced its media connection");
/** The failures that are not the SDK replacing a media connection, for tests of the grant arithmetic that a replacement moves. */
const otherThanReplacement = (call) => judged(call).filter((failure) => !replacedMedia(failure));
const onlyGuest = (call, guest, change) => ({ ...call, ticks: call.ticks.map((tick) => ({ ...tick, guests: tick.guests.map((sample, index) => (index === guest ? change(sample, tick.t - startedAtMs) : sample)) })) });

test("the call outlives two access lifetimes and refreshes at the numbers the code uses", () => {
  assert.ok(callDurationMs >= 10 * 60_000 && callDurationMs >= 2 * accessLifetimeMs);
  assert.equal(refreshIntervalMs, accessLifetimeMs - refreshWindowMs);
  assert.match(read("../../apps/api/internal/accessgrants/types.go"), new RegExp(`Lifetime\\s+=\\s+${accessLifetimeMs / 60_000} \\* time\\.Minute`));
  assert.match(read("../../sdks/typescript/client/src/access/manager.ts"), new RegExp(`DEFAULT_REFRESH_WINDOW_MS = ${refreshWindowMs}`));
});

test("every guest toggles mic and camera around each refresh boundary", () => {
  const guestCount = 10;
  const schedule = toggleSchedule({ guestCount });
  for (let boundary = refreshIntervalMs; boundary + 10_000 < callDurationMs; boundary += refreshIntervalMs) {
    const near = schedule.filter((toggle) => Math.abs(toggle.atMs - boundary) <= bounds.acrossRefreshMs);
    for (let guest = 0; guest < guestCount; guest++) {
      const own = near.filter((toggle) => toggle.guest === guest);
      assert.ok(own.some((toggle) => toggle.atMs < boundary) && own.some((toggle) => toggle.atMs >= boundary), `guest ${guest + 1} has no toggle on both sides of +${boundary / 1000}s`);
      assert.deepEqual([...new Set(own.map((toggle) => toggle.kind))].sort(), ["camera", "microphone"]);
    }
  }
  assert.ok(schedule.every((toggle, index) => index === 0 || toggle.atMs >= schedule[index - 1].atMs));
  assert.ok(schedule.every((toggle) => toggle.atMs < callDurationMs));
});

test("the refresh boundaries follow the first credential expiry of the call", () => {
  const shifted = toggleSchedule({ firstRefreshMs: 220_000 });
  assert.ok(shifted.some((toggle) => Math.abs(toggle.atMs - 220_000) <= 8000));
  assert.ok(shifted.some((toggle) => Math.abs(toggle.atMs - (220_000 + refreshIntervalMs)) <= 8000));
});

test("a healthy call passes and prints one evidence line", () => {
  const result = judge({ ...healthyCall(), signalBytes: [20_000, 14_000, 15_000] });
  assert.deepEqual(result.failures, []);
  assert.equal(evidenceLine(result.evidence), `Long call: 3 guests, ${callDurationMs / 1000}s, 2 access refreshes seen, ${toggleSchedule().length} mic/camera toggles, signaling requests (bytes/bar) G1 20000/49152, G2 14000/49152, G3 15000/49152 (max 20000), 0 failures`);
});

test("the three-guest signal bar remains 48 KiB and fails before the node's 256 KiB cap", () => {
  const failures = judged({ ...healthyCall(), signalBytes: [20_000, bounds.signalBytes + 1, 15_000] });
  assert.equal(failures.length, 1, failures.join("\n"));
  assert.match(failures[0], /^Guest 2 sent a signaling request of \d+ bytes, over the 49152 byte limit.*256 KiB cap/);
  assert.deepEqual(judged({ ...healthyCall(), signalBytes: [bounds.signalBytes, 0, 0] }), []);
});

test("a ten-guest run uses the 176 KiB SDK budget and checks every other guest after each microphone publish", () => {
  const ten = healthyCall({ participants: Array.from({ length: 10 }, (_, guest) => `p${guest + 1}`), toggles: toggleSchedule({ guestCount: 10 }) });
  const signalBytes = Array.from({ length: 10 }, (_, guest) => (guest === 0 ? 176 * 1024 : 70_000 + guest));
  const result = judge({ ...ten, signalBytes });
  assert.deepEqual(result.failures, []);
  assert.equal(result.evidence.signalLimitBytes, 176 * 1024);
  assert.deepEqual(result.evidence.signalBytesByGuest, signalBytes);
  const speaker = 9;
  const toggle = ten.toggles.filter((entry) => entry.guest === speaker && entry.kind === "microphone" && entry.enabled).at(-1);
  const hearings = heardEveryUnmute(ten);
  assert.equal(hearings.find((hearing) => hearing.speaker === speaker && hearing.atMs === toggle.atMs).verdicts.length, 9);
  const missingListener = hearings.map((hearing) => (hearing.speaker === speaker && hearing.atMs === toggle.atMs ? { ...hearing, verdicts: hearing.verdicts.filter((verdict) => verdict.listener !== 1) } : hearing));
  const hearingFailure = judged({ ...ten, signalBytes, hearings: missingListener }).find((failure) => failure.includes("checked at 8 of 9 other guests"));
  assert.ok(hearingFailure, "the deafness probe must require every other guest");
  const tooLarge = [...signalBytes];
  tooLarge[0] += 1;
  assert.equal(judged({ ...ten, signalBytes: tooLarge })[0], "Guest 1 sent a signaling request of 180225 bytes, over the 180224 byte limit that keeps its offer clear of the node's 256 KiB cap; the offer grows with every media section the connection has closed");
});

test("the recorded rehearsal where the microphone stopped publishing after a refresh fails", () => {
  const { samples } = JSON.parse(read("./fixtures/long-call-mic-stops.json"));
  const ticks = samples.map((sample) => ({ t: startedAtMs + sample.t * 1000, guests: [{ ...sample, reachable: true, status: "live", errorCode: null, remotes: [] }] }));
  const failures = judged({ ticks, participants: ["p1"], refreshes: [{ guest: 1, requests: [] }], toggles: [], startedAtMs });
  const stopped = failures.filter((failure) => /^Guest 1 sent no audio for \d+ s \(\+\d+s to \+\d+s\) while its microphone showed on$/.test(failure));
  assert.equal(stopped.length, 1, failures.join("\n"));
  const [from] = /\+(\d+)s/.exec(stopped[0]).slice(1).map(Number);
  assert.ok(from >= 210 && from <= 240, `the stall starts at +${from}s`);
});

test("the same rehearsal passes the audio rule once audio keeps moving, and a muted microphone is not a stall", () => {
  const { samples } = JSON.parse(read("./fixtures/long-call-mic-stops.json"));
  const sound = (change) =>
    judged({
      ticks: samples.map((sample, index) => ({ t: startedAtMs + sample.t * 1000, guests: [{ ...sample, ...change(sample, index), reachable: true, status: "live", errorCode: null, remotes: [] }] })),
      participants: ["p1"],
      refreshes: [{ guest: 1, requests: [] }],
      toggles: [],
      startedAtMs,
    }).filter((failure) => failure.includes("sent no audio"));
  assert.deepEqual(
    sound((sample, index) => ({ outAudio: sample.outAudio || 1000 * index })),
    [],
  );
  assert.deepEqual(
    sound((sample) => ({ mic: sample.t < 210 ? sample.mic : false })),
    [],
  );
});

test("a lost call, a rejected access, or a failed refresh fails", () => {
  const call = healthyCall();
  assert.match(judged(onlyGuest(call, 1, (sample, at) => (at >= 250_000 ? { ...sample, status: "failed", errorCode: "access.invalid" } : sample)))[0], /^Guest 2 lost the call at \+250s: status failed, error access\.invalid$/);
  const rejected = { ...call, refreshes: [call.refreshes[0], { guest: 2, requests: [{ status: 403, code: "access.invalid", startedAt: new Date(startedAtMs + refreshIntervalMs).toISOString() }] }, call.refreshes[2]] };
  assert.ok(judged(rejected).includes("Guest 2's access refresh failed with status 403 (access.invalid)"));
});

test("a peer connection that closes without a successor, or a page that stops answering, fails", () => {
  const call = healthyCall();
  const closed = judged(onlyGuest(call, 2, (sample, at) => (at >= 300_000 ? { ...sample, pcs: ["closed", "closed"] } : sample)));
  assert.ok(
    closed.some((failure) => /^Guest 3 had no connected peer connection for more than 10 s/.test(failure)),
    closed.join("\n"),
  );
  const silent = judged(onlyGuest(call, 0, (sample, at) => (at >= 100_000 && at < 130_000 ? unreachableSample : sample)));
  assert.ok(
    silent.some((failure) => /^Guest 1 was not live for more than 10 s/.test(failure)),
    silent.join("\n"),
  );
  assert.deepEqual(judged(onlyGuest(call, 0, (sample, at) => (at >= 100_000 && at < 106_000 ? { ...sample, status: "reconnecting" } : sample))), []);
});

test("outbound audio that stands still for more than 8 s while the microphone is on fails, and a shorter pause does not", () => {
  const call = healthyCall();
  const frozen = (from, to) => onlyGuest(call, 1, (sample, at) => (at >= from && at < to ? { ...sample, outAudio: 777 } : sample));
  assert.deepEqual(judged(frozen(300_000, 308_000)), []);
  const failures = judged(frozen(300_000, 330_000));
  assert.ok(
    failures.some((failure) => /^Guest 2 sent no audio for \d+ s/.test(failure)),
    failures.join("\n"),
  );
});

test("inbound audio or video that stands still for more than 10 s while its sender is on fails, and one that is off does not", () => {
  const call = healthyCall();
  const stuck = (source, from, to) => ({
    ...call,
    ticks: call.ticks.map((tick) => {
      const at = tick.t - startedAtMs;
      if (at < from || at >= to) return tick;
      return { ...tick, guests: tick.guests.map((sample, index) => (index === 0 ? { ...sample, remotes: sample.remotes.map((remote) => (remote.participantId === "p3" && remote.source === source ? { ...remote, bytes: 42 } : remote)) } : sample)) };
    }),
  });
  assert.deepEqual(judged(stuck("microphone", 100_000, 108_000)), []);
  assert.ok(judged(stuck("microphone", 100_000, 130_000)).some((failure) => /^Guest 1 received no audio from guest 3 for \d+ s/.test(failure)));
  assert.ok(judged(stuck("camera", 100_000, 130_000)).some((failure) => /^Guest 1 received no video from guest 3 for \d+ s/.test(failure)));
  const missing = judged(onlyGuest(call, 0, (sample, at) => (at >= 100_000 && at < 130_000 ? { ...sample, remotes: sample.remotes.filter((remote) => remote.participantId !== "p2") } : sample)));
  assert.ok(
    missing.some((failure) => /^Guest 1 received no audio from guest 2/.test(failure)),
    missing.join("\n"),
  );
});

test("a refresh that no toggle crossed on each side, or too few refreshes, fails because the call did not test what it must", () => {
  const call = healthyCall({ toggles: toggleSchedule().filter((toggle) => Math.abs(toggle.atMs - refreshIntervalMs) > 30_000) });
  assert.ok(judged(call).some((failure) => failure.includes("had no mic or camera toggle on each side within 10 s")));
  const once = { ...healthyCall(), refreshes: participants.map((_, index) => guestWith(index, [grant(refreshIntervalMs)])) };
  assert.ok(judged(once).some((failure) => failure.startsWith("Guests renewed their access 1, 1, 1 times")));
});

/** The refreshes and toggles of the nightly run 42725337871, numbers only (fixtures/long-call-nightly-refreshes.json). */
function observedNightly() {
  const observed = JSON.parse(read("./fixtures/long-call-nightly-refreshes.json"));
  const toggles = observed.toggles.map(([atMs, guest, kind, enabled]) => ({ atMs, guest, kind, enabled }));
  const refreshes = observed.guests.map(({ initialExpiryMs, requests }, index) => ({
    guest: index + 1,
    initialExpiry: startedAtMs + initialExpiryMs,
    requests: requests.map((request) => ({ ...grant(request.atMs, { replace: request.replaceMediaConnection }), reason: request.reason })),
  }));
  return { observed, toggles, refreshes };
}

test("the observed nightly run: a replacement moved guest 2's refresh to +367 s, which only a toggle planned from its grant crosses", () => {
  const { observed, toggles, refreshes } = observedNightly();
  const call = (list) => ({ ...healthyCall({ durationMs: observed.durationMs, toggles: list }), refreshes, toggles: list });
  // What the fixed schedule did: the +367 s refresh had no toggle. The old judge also called the shifted refresh count a failure; the grants are consistent.
  assert.deepEqual(otherThanReplacement(call(toggles)), ["1 access refresh(es) at +367s had no mic or camera toggle on each side within 10 s, so they were not tested"]);
  assert.deepEqual(judged(call(toggles)).filter(replacedMedia), ["Guest 2 replaced its media connection at +127s (retry, status 201) with no fault injected"]);
  const planned = [...toggles, ...refreshToggles(366_900, 1)].sort((a, b) => a.atMs - b.atMs);
  assert.deepEqual(otherThanReplacement(call(planned)), []);
});

test("refreshes of different guests a few seconds apart each get their own toggles on both sides", () => {
  const dues = [
    { key: "1:a", guest: 0, dueMs: 231_000 },
    { key: "2:a", guest: 1, dueMs: 243_000 },
    { key: "3:a", guest: 2, dueMs: 234_000 },
  ];
  const planned = new Set();
  const first = planRefreshToggles({ dues, nowMs: 100_000, planned });
  assert.equal(first.length, 3 * refreshToggles(0).length);
  assert.deepEqual(planRefreshToggles({ dues, nowMs: 100_000, planned }), [], "a refresh is planned once");
  const stagger = (list) => {
    const call = healthyCall({ toggles: [...toggleSchedule({ firstRefreshMs: 5_000_000 }), ...list].sort((a, b) => a.atMs - b.atMs) });
    const refreshes = [guestWith(0, [grant(231_000), grant(471_000)]), guestWith(1, [grant(243_000), grant(483_000)]), guestWith(2, [grant(234_000), grant(474_000)])];
    return judged({
      ...call,
      refreshes,
      toggles: call.toggles
        .filter((toggle) => toggle.atMs < 460_000 || toggle.atMs > 490_000)
        .concat(refreshToggles(471_000, 0), refreshToggles(483_000, 1), refreshToggles(474_000, 2))
        .sort((a, b) => a.atMs - b.atMs),
    });
  };
  assert.deepEqual(stagger(first), []);
  // One group for all three, as the first version planned, leaves the +243 s refresh without a toggle after it.
  assert.ok(stagger(refreshToggles(231_000, 0)).some((failure) => failure.startsWith("1 access refresh(es) at +243s had no mic or camera toggle on each side")));
});

test("a refresh planned for a guest with a new grant, or too late for a group, is handled", () => {
  const planned = new Set(["1:a"]);
  assert.deepEqual(planRefreshToggles({ dues: [{ key: "1:a", dueMs: 300_000 }], nowMs: 0, planned }), []);
  assert.ok(planRefreshToggles({ dues: [{ key: "1:b", dueMs: 367_000 }], nowMs: 127_000, planned }).length > 0, "a new grant gets a new group");
  assert.deepEqual(planRefreshToggles({ dues: [{ key: "1:c", dueMs: 595_000 }], nowMs: 127_000, planned }), [], "a group would run past the end");
  assert.deepEqual(planRefreshToggles({ dues: [{ key: "1:d", dueMs: 135_000 }], nowMs: 127_000, planned }), [], "less than 9 s is left");
});

test("a refresh shifted into the last 10 s is renewed and noted, but needs no toggle after it", () => {
  const call = healthyCall({ durationMs: 598_000 });
  const late = (renewals) => ({ ...call, refreshes: [call.refreshes[0], guestWith(1, renewals), call.refreshes[2]] });
  // A replacement at +115 s moves the refreshes to +355 s and +595 s.
  const renewals = [grant(115_000, { replace: true }), grant(355_000), grant(595_000)];
  const toggles = [...call.toggles, ...refreshToggles(355_000, 1)].sort((a, b) => a.atMs - b.atMs);
  const result = judge({ ...call, refreshes: late(renewals).refreshes, toggles });
  assert.deepEqual(result.failures, ["Guest 2 replaced its media connection at +115s (retry, status 201) with no fault injected"]);
  assert.deepEqual(result.notes, ["The access refresh at +595s fell in the last 10 s of the call, so no toggle could follow it; it was not toggle-tested"]);
  // The same shift still fails when the +595 s renewal never came and the grant is overdue, or when a refresh before the last 10 s has no toggle.
  assert.ok(judged({ ...late(renewals.slice(0, 2)), toggles: call.toggles }).some((failure) => failure.includes("1 access refresh(es) at +355s")));
  assert.deepEqual(otherThanReplacement({ ...late([grant(115_000, { replace: true }), grant(355_000)]), toggles }), []);
  const overdue = healthyCall({ durationMs: 598_000 });
  assert.ok(
    judged({ ...overdue, refreshes: [overdue.refreshes[0], guestWith(1, [grant(50_000, { replace: true }), grant(290_000)]), overdue.refreshes[2]], toggles: [...overdue.toggles, ...refreshToggles(290_000, 1)] }).some((failure) => failure.startsWith("Guest 2 did not renew its access, due at +530s")),
  );
});

test("a refresh that never came, came late, or was only ever a replacement fails", () => {
  const call = healthyCall();
  const withGuest2 = (requests) => ({ ...call, refreshes: [call.refreshes[0], guestWith(1, requests), call.refreshes[2]] });
  // A replacement at +127 s moves the due time to +367 s; nothing after it leaves the call past the due time without a renewal.
  assert.ok(judged(withGuest2([grant(126_800, { replace: true })])).some((failure) => failure.startsWith("Guest 2 did not renew its access, due at +367s")));
  assert.ok(judged(withGuest2([grant(300_000), grant(2 * refreshIntervalMs)])).some((failure) => failure.startsWith("Guest 2 renewed its access at +300s, 60 s after the refresh was due")));
  assert.ok(judged(withGuest2([grant(126_800, { replace: true }), grant(366_900, { replace: true })])).some((failure) => failure === "Guests renewed their access 2, 2, 2 times (2, 0, 2 scheduled); at least 2 each, with at least 1 scheduled, were expected in this call"));
});

test("one group of refresh toggles has a toggle on each side of a refresh within 2 s of its due time", () => {
  const toggles = refreshToggles(300_000);
  for (let at = 298_000; at <= 302_000; at += 1000) {
    assert.ok(toggles.some((toggle) => toggle.atMs >= at - bounds.acrossRefreshMs && toggle.atMs <= at));
    assert.ok(toggles.some((toggle) => toggle.atMs >= at && toggle.atMs <= at + bounds.acrossRefreshMs));
  }
});

test("guest 1 mutes and unmutes its microphone, then guest 2 does, before the first baseline toggle", () => {
  const [first, second, third, fourth, fifth] = toggleSchedule();
  assert.deepEqual(
    [first, second, third, fourth].map(({ guest, kind, enabled }) => [guest, kind, enabled]),
    [
      [0, "microphone", false],
      [0, "microphone", true],
      [1, "microphone", false],
      [1, "microphone", true],
    ],
  );
  assert.ok(second.atMs < third.atMs && third.atMs - second.atMs <= bounds.acrossRefreshMs, "guest 2 mutes right after guest 1 is back");
  assert.ok(fourth.atMs < fifth.atMs, "the relay ends before the baseline starts");
});

test("a peer connection that leaves connected fails once, whatever it leaves for, and a new one that is still connecting does not", () => {
  const call = healthyCall();
  // The nightly shape: guest 2's only live connection went back to new in place at its first toggle, then a successor connected.
  const dropped = judged(onlyGuest(call, 1, (sample, at) => (at >= 120_000 && at < 128_000 ? { ...sample, pcs: ["closed", "new"] } : sample)));
  assert.deepEqual(dropped, ["Guest 2 peer connection 2 left connected for new at +120s"]);
  const disconnected = judged(onlyGuest(call, 0, (sample, at) => (at >= 200_000 && at < 202_000 ? { ...sample, pcs: ["closed", "disconnected"] } : sample)));
  assert.deepEqual(disconnected, ["Guest 1 peer connection 2 left connected for disconnected at +200s"]);
  const closed = judged(onlyGuest(call, 2, (sample, at) => (at >= 300_000 ? { ...sample, pcs: ["closed", "closed", "connected"] } : sample)));
  assert.deepEqual(closed, ["Guest 3 peer connection 2 left connected for closed at +300s"]);
  // A connection that starts out new or connecting and then connects, and an unanswered page, are not leaving connected.
  const joining = judged(onlyGuest(call, 1, (sample, at) => (at < 6000 ? { ...sample, pcs: ["connecting"] } : at < 10_000 ? unreachableSample : sample)));
  assert.deepEqual(joining, []);
});

test("a media-connection replacement fails the call because the proof injects no fault", () => {
  const call = healthyCall();
  const refreshes = [call.refreshes[0], call.refreshes[1], guestWith(2, [grant(126_800, { replace: true }), grant(366_800), grant(606_800 - 1000)])];
  const failures = judged({ ...call, refreshes }).filter(replacedMedia);
  assert.deepEqual(failures, ["Guest 3 replaced its media connection at +127s (retry, status 201) with no fault injected"]);
});

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

test("a rotation the SDK reports is planned and matched to its own replacement and closed connection; any other replacement or closed connection still fails", () => {
  const call = healthyCall();
  const recovery = (failure) => replacedMedia(failure) || failure.includes("left connected");
  const judgedRecovery = (call, ...rotationsMs) => judged({ ...call, budgetReplacements: [[], [], rotationsMs.map((atMs) => startedAtMs + atMs)] }).filter(recovery);
  const withRefreshes = (renewals) => ({ ...call, refreshes: [call.refreshes[0], call.refreshes[1], guestWith(2, renewals)] });
  const closedFrom = (call, closings) => onlyGuest(call, 2, (sample, at) => ({ ...sample, pcs: [...Array(closings.filter((closedAt) => at >= closedAt).length + 1).fill("closed"), "connected"] }));
  const rotated = closedFrom(withRefreshes([grant(126_800, { replace: true }), grant(366_800), grant(606_800 - 1000)]), [127_000]);

  // One reported rotation near the request plans the guest's replacement request and its closed connection.
  assert.deepEqual(judgedRecovery(rotated, 128_000), []);
  // The same events with no rotation reported are unexpected recovery.
  assert.equal(judgedRecovery(rotated).length, 2);
  // A rotation far from the events does not explain them.
  assert.equal(judgedRecovery(rotated, 400_000).length, 2);

  // An unplanned recovery before a rotation keeps failing, and the rotation still plans its own request.
  const both = closedFrom(withRefreshes([grant(60_000, { replace: true }), grant(126_800, { replace: true }), grant(366_800), grant(606_800 - 1000)]), [60_000, 127_000]);
  const failures = judgedRecovery(both, 128_000);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((failure) => failure.includes("+60s") || failure.includes("+65s") || failure.includes("+55s")));

  // Only a closure belongs to a rotation: a connection that disconnects near one, then closes, still fails.
  const dropped = onlyGuest(rotated, 2, (sample, at) => (at >= 125_000 && at < 127_000 ? { ...sample, pcs: ["closed", "disconnected"] } : sample));
  assert.equal(judgedRecovery(dropped, 128_000).filter((failure) => failure.includes("left connected for disconnected")).length, 1);
});
