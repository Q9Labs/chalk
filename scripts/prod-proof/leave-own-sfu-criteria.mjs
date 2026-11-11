import { setTimeout as delay } from "node:timers/promises";

// What one guest's Leave must leave behind on the own SFU, judged from what the pages and the API reported.
const leaveCeilingMs = 5000;
const releaseCeilingMs = 10_000;

// Samples the leaver's capture until it is released or the deadline, counted from `began` (the start of the Leave), passes.
// The last sample is always taken at or after the deadline, so tracks that ended just before it are seen as ended.
export async function awaitRelease(sample, began, { now = () => performance.now(), sleep = delay, ceilingMs = releaseCeilingMs, intervalMs = 250 } = {}) {
  let after = await sample();
  while (after.live !== 0 && now() - began < ceilingMs) {
    await sleep(intervalMs);
    after = await sample();
  }
  return { after, ms: Math.round(now() - began) };
}

export function evaluateOwnSfuLeave(sample) {
  const { leave, capture, release, survivor, episodeStatus } = sample;
  const failures = [];
  if (!leave.confirmed || leave.deadlineFallback) failures.push("The Sync acknowledgement of the Leave did not arrive before the SDK's deadline");
  if (!(leave.ms <= leaveCeilingMs)) failures.push(`The Leave took ${Math.round(leave.ms)} ms, over ${leaveCeilingMs} ms`);
  if (leave.peerClosedBeforeAck) failures.push("The media connection closed before the Leave was acknowledged");
  if (!(capture.audio >= 1 && capture.video >= 1)) failures.push("The leaving guest held no live microphone and camera before the Leave, so the release proves nothing");
  if (release.live !== 0) failures.push(`${release.live} capture track(s) of the leaving guest were still live ${releaseCeilingMs} ms after the Leave began`);
  else if (!(release.ms <= releaseCeilingMs)) failures.push(`The capture was released ${Math.round(release.ms)} ms after the Leave began, over ${releaseCeilingMs} ms`);
  if (!survivor.rosterWithoutLeaver) failures.push("The remaining guest still lists the leaver as a participant");
  if (!survivor.remoteWithoutLeaver) failures.push("The remaining guest still receives media from the leaver");
  if (!survivor.ownTracksLive) failures.push("The remaining guest stopped its own capture when the other guest left");
  if (episodeStatus !== "active") failures.push(`The Episode is ${episodeStatus}, not active, after one of two guests left`);
  return { passed: failures.length === 0, failures };
}

// The scorecard reads the shape of the Leave comparison: one sample per run here.
export function scorecardShape(sample, evaluation) {
  const ms = sample.leave.ms;
  return { passed: evaluation.passed, candidateSamples: 1, candidateMedianMs: ms, candidateMaxMs: ms, plane: "chalk_sfu" };
}
