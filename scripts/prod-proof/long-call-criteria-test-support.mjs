import { accessLifetimeMs, bounds, callDurationMs, refreshIntervalMs, toggleSchedule } from "./long-call-schedule.mjs";
import { judgeLongCall } from "./long-call-criteria.mjs";

export const startedAtMs = Date.parse("2026-11-10T02:00:00Z");
export const participants = ["p1", "p2", "p3"];

/** A grant request `atMs` into the call; the grant it returns lives one access lifetime. */
export const grant = (atMs, { replace = false } = {}) => ({
  status: 201,
  reason: replace ? "retry" : "refresh", // the names the proof records
  replaceMediaConnection: replace,
  startedAt: new Date(startedAtMs + atMs).toISOString(),
  mediaExpiry: startedAtMs + atMs + accessLifetimeMs,
});
export const guestWith = (index, requests) => ({ guest: index + 1, initialExpiry: startedAtMs + accessLifetimeMs, requests });

/** A healthy call, sampled like the proof does: a counter climbs while its source is on and restarts after each toggle. */
export function healthyCall({ durationMs = callDurationMs, toggles = toggleSchedule(), participants: guestParticipants = participants } = {}) {
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
export const heardEveryUnmute = ({ toggles, participants: guestParticipants }) =>
  toggles
    .filter((toggle) => toggle.kind === "microphone" && toggle.enabled)
    .map(({ guest, atMs }) => ({ speaker: guest, atMs, verdicts: guestParticipants.flatMap((_, listener) => (listener === guest ? [] : [{ listener: listener + 1, speaker: guest + 1, pass: true, peakDb: -25, bin: 38, floorDb: -90 }])) }));
export const judge = (call) => judgeLongCall({ hearings: heardEveryUnmute(call), ...call });
export const judged = (call) => judge(call).failures;
export const replacedMedia = (failure) => failure.includes("replaced its media connection");
/** The failures that are not the SDK replacing a media connection, for tests of the grant arithmetic that a replacement moves. */
export const otherThanReplacement = (call) => judged(call).filter((failure) => !replacedMedia(failure));
export const onlyGuest = (call, guest, change) => ({ ...call, ticks: call.ticks.map((tick) => ({ ...tick, guests: tick.guests.map((sample, index) => (index === guest ? change(sample, tick.t - startedAtMs) : sample)) })) });
