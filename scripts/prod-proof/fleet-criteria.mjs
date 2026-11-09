// Pass and fail rules for the canary fleet, apart from the browsers and the API that feed them.
// The thresholds are the M7 canary check in docs/sfu/milestones.md.
import { percentile } from "./sfu-canary-criteria.mjs";

export const joinLimitMs = 10_000;
export const recoveryLimitMs = 15_000;
// The M7 exit by volume: at least this many calls and call-hours with no P1.
export const volumeExit = { calls: 200, callHours: 50 };

// A reason is P1 when it breaks a hard M7 condition. Every other reason fails a call but is not a release blocker by itself.
const p1Reasons = new Set(["cross_tenant", "mute_leak", "consent_reenabled", "join_over_limit", "join_not_rendered", "recovery_over_limit", "recovery_not_rendered"]);

export function finding(reason, detail) {
  return { reason, detail, p1: p1Reasons.has(reason) };
}

/** What every guest's page must show of the others: `state[id]` is `{ microphone, camera, screen }`, true when that source is published. */
export function expectedSources(state, self) {
  return Object.entries(state)
    .filter(([id]) => id !== self)
    .flatMap(([id, on]) => [on.microphone && [id, "microphone", "audio"], on.camera && [id, "camera", "video"], on.screen && [id, "screen", "video"]].filter(Boolean));
}

const find = (sample, [id, source, kind]) => sample.rows.filter((row) => row.participantId === id && row.source === source && row.kind === kind);

/** The expected sources that have not delivered yet (any audio byte, one decoded video frame). Empty means the first render is complete. */
export function missingSources(sample, state) {
  return expectedSources(state, sample.self).filter((stream) => !find(sample, stream).some((row) => (stream[2] === "video" ? row.frames > 0 : row.bytes > 0)));
}

const grew = (stream, before, after) => find(after, stream).some((row) => find(before, stream).some((earlier) => earlier.key === row.key && (stream[2] === "video" ? row.frames > earlier.frames : row.bytes > earlier.bytes)));

/** The expected sources whose counters did not advance on the same connection and track between two samples. */
export function stalledSources(before, after, state) {
  return expectedSources(state, after.self).filter((stream) => !grew(stream, before, after));
}

// A headless page does not play audio out, so the browser reports no audio energy: audio is judged by bytes per second.
// The generated tone is about 4 kB/s; a muted microphone sends nothing or DTX comfort noise, far under this line.
export const audioLeakBytesPerSecond = 1500;

const rate = (row, earlier, seconds) => (row.bytes - earlier.bytes) / seconds;

/** Sources of `participantId` that still reach this page after they were turned off: audio bytes or camera frames kept coming. */
export function leakedSources(before, after, participantId, off) {
  const leaks = [];
  const seconds = Math.max(0.5, (after.at - before.at) / 1000);
  const audio = [participantId, "microphone", "audio"];
  if (off.includes("microphone") && find(after, audio).some((row) => find(before, audio).some((earlier) => earlier.key === row.key && rate(row, earlier, seconds) > audioLeakBytesPerSecond))) leaks.push("microphone");
  if (off.includes("camera") && grew([participantId, "camera", "video"], before, after)) leaks.push("camera");
  return leaks;
}

/** Participant ids on a page that do not belong to its call: the closest check to cross-Tenant leakage that one Tenant allows. */
export function foreignParticipants(sample, callParticipants) {
  const known = new Set(callParticipants);
  return [...new Set([...sample.roster, ...sample.remote.map((entry) => entry.participantId), ...sample.rows.map((row) => row.participantId)])].filter((id) => !known.has(id));
}

/** The call-hours of a call: from every guest rendering to the end of the Episode. */
export function callHours(call) {
  return call.renderedAt !== undefined && call.endedAt !== undefined ? Math.max(0, call.endedAt - call.renderedAt) / 3_600_000 : 0;
}

const times = (values) => values.filter((value) => value !== undefined);
const stat = (values) => ({ trials: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: values.length ? Math.max(...values) : null });

/** One summary over the calls of one or several fleet runs; the lead merges the machines' runs with it. */
export function summarizeFleet(calls) {
  const findings = calls.flatMap((call) => call.findings.map((entry) => ({ call: call.id, ...entry })));
  const p1 = findings.filter((entry) => entry.p1);
  const hours = calls.reduce((total, call) => total + callHours(call), 0);
  const participantHours = calls.reduce((total, call) => total + callHours(call) * call.guests, 0);
  const byReason = {};
  for (const entry of findings) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  const completed = calls.filter((call) => call.endedAt !== undefined && !call.error);
  return {
    calls: calls.length,
    completedCalls: completed.length,
    erroredCalls: calls.filter((call) => call.error).length,
    callHours: Number(hours.toFixed(2)),
    participantHours: Number(participantHours.toFixed(2)),
    p1: p1.length,
    findings: byReason,
    p1Findings: p1,
    join: stat(times(calls.map((call) => call.joinMs))),
    recovery: stat(times(calls.flatMap((call) => call.faults.map((fault) => fault.ms)))),
    faultTrials: calls.reduce((total, call) => total + call.faults.length, 0),
    meetsVolumeExit: calls.length >= volumeExit.calls && hours >= volumeExit.callHours,
    result: p1.length === 0 && calls.every((call) => !call.error && call.findings.length === 0) ? "passed" : "failed",
  };
}

/** Whether the scheduler may start another call: the targets are not covered by finished and running calls, and no P1 has stopped the run. */
export function wantsMoreCalls({ started, doneHours, runningHours, p1 }, targets, stopOnP1) {
  if (stopOnP1 && p1 > 0) return false;
  return started < targets.calls || doneHours + runningHours < targets.callHours;
}
