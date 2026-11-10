// What one guest's Leave must leave behind on the own SFU, judged from what the pages and the API reported.
export const leaveCeilingMs = 5000;
export const releaseCeilingMs = 10_000;

export function evaluateOwnSfuLeave(sample) {
  const { leave, capture, release, survivor, episodeStatus } = sample;
  const failures = [];
  if (!leave.confirmed || leave.deadlineFallback) failures.push("The Sync acknowledgement of the Leave did not arrive before the SDK's deadline");
  if (!(leave.ms <= leaveCeilingMs)) failures.push(`The Leave took ${Math.round(leave.ms)} ms, over ${leaveCeilingMs} ms`);
  if (leave.peerClosedBeforeAck) failures.push("The media connection closed before the Leave was acknowledged");
  if (!(capture.audio >= 1 && capture.video >= 1)) failures.push("The leaving guest held no live microphone and camera before the Leave, so the release proves nothing");
  if (release.live !== 0) failures.push(`${release.live} capture track(s) of the leaving guest were still live ${releaseCeilingMs} ms after the Leave`);
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
