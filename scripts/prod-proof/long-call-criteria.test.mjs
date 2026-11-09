import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessLifetimeMs, bounds, callDurationMs, evidenceLine, judgeLongCall, refreshIntervalMs, refreshWindowMs, toggleSchedule, unreachableSample } from "./long-call-criteria.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const startedAtMs = Date.parse("2026-11-10T02:00:00Z");
const participants = ["p1", "p2", "p3"];

/** A healthy three-guest call, sampled like the proof does: a counter climbs while its source is on and restarts after each toggle. */
function healthyCall({ durationMs = callDurationMs, toggles = toggleSchedule() } = {}) {
  const counters = participants.map(() => ({ mic: 0, camera: 0 }));
  const ticks = [];
  for (let at = 0; at <= durationMs; at += bounds.sampleIntervalMs) {
    const on = participants.map((_, guest) => {
      const state = { mic: true, camera: true };
      for (const toggle of toggles.filter((entry) => entry.guest === guest && entry.atMs <= at)) state[toggle.kind === "microphone" ? "mic" : "camera"] = toggle.enabled;
      return state;
    });
    participants.forEach((_, guest) => {
      for (const kind of ["mic", "camera"]) counters[guest][kind] = on[guest][kind] ? counters[guest][kind] + 5000 : 0;
    });
    ticks.push({
      t: startedAtMs + at,
      guests: participants.map((_, guest) => ({
        reachable: true,
        status: "live",
        errorCode: null,
        mic: on[guest].mic,
        camera: on[guest].camera,
        pcs: ["closed", "connected"],
        outAudio: counters[guest].mic,
        remotes: participants.flatMap((id, sender) =>
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
  const refreshes = participants.map((_, index) => ({
    guest: index + 1,
    requests: [refreshIntervalMs, 2 * refreshIntervalMs].map((at) => ({ status: 201, replaceMediaConnection: false, startedAt: new Date(startedAtMs + at).toISOString() })),
  }));
  return { ticks, participants, refreshes, toggles, startedAtMs };
}
const judged = (call) => judgeLongCall(call).failures;
const onlyGuest = (call, guest, change) => ({ ...call, ticks: call.ticks.map((tick) => ({ ...tick, guests: tick.guests.map((sample, index) => (index === guest ? change(sample, tick.t - startedAtMs) : sample)) })) });

test("the call outlives two access lifetimes and refreshes at the numbers the code uses", () => {
  assert.ok(callDurationMs >= 10 * 60_000 && callDurationMs >= 2 * accessLifetimeMs);
  assert.equal(refreshIntervalMs, accessLifetimeMs - refreshWindowMs);
  assert.match(read("../../apps/api/internal/accessgrants/types.go"), new RegExp(`Lifetime\\s+=\\s+${accessLifetimeMs / 60_000} \\* time\\.Minute`));
  assert.match(read("../../sdks/typescript/client/src/access/manager.ts"), new RegExp(`DEFAULT_REFRESH_WINDOW_MS = ${refreshWindowMs}`));
});

test("every refresh boundary has toggles on both sides, and two guests toggle both mic and camera", () => {
  const schedule = toggleSchedule();
  for (let boundary = refreshIntervalMs; boundary + 10_000 < callDurationMs; boundary += refreshIntervalMs) {
    const near = schedule.filter((toggle) => Math.abs(toggle.atMs - boundary) <= bounds.acrossRefreshMs);
    assert.ok(near.some((toggle) => toggle.atMs < boundary) && near.some((toggle) => toggle.atMs >= boundary), `no toggle on both sides of +${boundary / 1000}s`);
    assert.ok(new Set(near.map((toggle) => toggle.guest)).size >= 2);
  }
  for (const guest of [0, 1]) assert.deepEqual([...new Set(schedule.filter((toggle) => toggle.guest === guest).map((toggle) => toggle.kind))].sort(), ["camera", "microphone"]);
  assert.ok(schedule.every((toggle, index) => index === 0 || toggle.atMs >= schedule[index - 1].atMs));
  assert.ok(schedule.every((toggle) => toggle.atMs < callDurationMs));
});

test("the refresh boundaries follow the first credential expiry of the call", () => {
  const shifted = toggleSchedule({ firstRefreshMs: 220_000 });
  assert.ok(shifted.some((toggle) => Math.abs(toggle.atMs - 220_000) <= 8000));
  assert.ok(shifted.some((toggle) => Math.abs(toggle.atMs - (220_000 + refreshIntervalMs)) <= 8000));
});

test("a healthy call passes and prints one evidence line", () => {
  const result = judgeLongCall(healthyCall());
  assert.deepEqual(result.failures, []);
  assert.equal(evidenceLine(result.evidence), `Long call: 3 guests, ${callDurationMs / 1000}s, 2 access refreshes seen, ${toggleSchedule().length} mic/camera toggles, 0 failures`);
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

test("a refresh that no toggle crossed, or too few refreshes, fails because the call did not test what it must", () => {
  const call = healthyCall({ toggles: toggleSchedule().filter((toggle) => Math.abs(toggle.atMs - refreshIntervalMs) > 30_000) });
  assert.ok(judged(call).some((failure) => failure.includes("had no mic or camera toggle within 10 s")));
  const once = { ...healthyCall(), refreshes: participants.map((_, index) => ({ guest: index + 1, requests: [{ status: 201, replaceMediaConnection: false, startedAt: new Date(startedAtMs + refreshIntervalMs).toISOString() }] })) };
  assert.ok(judged(once).some((failure) => failure.startsWith("Guests saw 1, 1, 1 access refreshes")));
});
