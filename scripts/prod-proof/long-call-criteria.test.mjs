import assert from "node:assert/strict";
import test from "node:test";
import { bounds, callDurationMs, refreshIntervalMs, toggleSchedule } from "./long-call-schedule.mjs";
import { evidenceLine, judgeLongCall, unreachableSample } from "./long-call-criteria.mjs";
import { startedAtMs, participants, grant, guestWith, healthyCall, heardEveryUnmute, judge, judged, replacedMedia, otherThanReplacement, onlyGuest } from "./long-call-criteria-test-support.mjs";
test("a healthy call passes and prints one evidence line", () => {
  const result = judge({ ...healthyCall(), signalBytes: [20_000, 14_000, 15_000] });
  assert.deepEqual(result.failures, []);
  assert.equal(
    evidenceLine(result.evidence),
    `Long call: 3 guests, ${callDurationMs / 1000}s, 2 access refreshes seen, ${toggleSchedule().length} mic/camera toggles, signaling requests (bytes/gate) G1 20000/131072 (target 48 KiB / 49152 B; over by 0 B), G2 14000/131072 (target 48 KiB / 49152 B; over by 0 B), G3 15000/131072 (target 48 KiB / 49152 B; over by 0 B) (max 20000), 0 failures`,
  );
});

test("three-guest signaling uses half the node cap as the gate and reports the 48 KiB target", () => {
  const cut = judge({ ...healthyCall(), signalBytes: [59_260, 68_382, 66_958] });
  assert.deepEqual(cut.failures, []);
  assert.equal(cut.evidence.signalLimitBytes, 131_072);
  assert.equal(cut.evidence.signalTargetBytes, 49_152);
  assert.deepEqual(cut.evidence.signalOverTargetBytesByGuest, [10_108, 19_230, 17_806]);
  assert.match(evidenceLine(cut.evidence), /G2 68382\/131072 \(target 48 KiB \/ 49152 B; over by 19230 B\)/);

  const tooLarge = judged({ ...healthyCall(), signalBytes: [20_000, 140_000, 15_000] });
  assert.equal(tooLarge.length, 1, tooLarge.join("\n"));
  assert.match(tooLarge[0], /^Guest 2 sent a signaling request of 140000 bytes, over the 131072 byte limit.*256 KiB cap/);
  assert.deepEqual(judged({ ...healthyCall(), signalBytes: [20_000, 131_072, 15_000] }), []);
  assert.match(judged({ ...healthyCall(), signalBytes: [20_000, 131_073, 15_000] })[0], /over the 131072 byte limit/);
});

test("a ten-guest run uses the 176 KiB SDK budget and checks every other guest after each microphone publish", () => {
  const ten = healthyCall({ participants: Array.from({ length: 10 }, (_, guest) => `p${guest + 1}`), toggles: toggleSchedule({ guestCount: 10 }) });
  const signalBytes = Array.from({ length: 10 }, (_, guest) => (guest === 0 ? 176 * 1024 : 70_000 + guest));
  const result = judge({ ...ten, signalBytes });
  assert.deepEqual(result.failures, []);
  assert.equal(result.evidence.signalLimitBytes, 176 * 1024);
  assert.equal(result.evidence.signalTargetBytes, 49_152);
  assert.deepEqual(result.evidence.signalBytesByGuest, signalBytes);
  assert.equal(result.evidence.signalOverTargetBytesByGuest[0], 131_072);
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
