import { launchGuests, waitForMediaProgress } from "./media.mjs";
import { evaluateOwnSfuLeave, releaseCeilingMs, scorecardShape } from "./leave-own-sfu-criteria.mjs";
import { measureLeave } from "./leave.mjs";
import { createSpace, prepareIntegration, trackEpisode } from "./proofs.mjs";
import { check, save, waitFor } from "./runtime.mjs";

// Collect every track the page captures, clones included, so the proof can see whether Leave released them.
function installCaptureTracking() {
  const tracks = (window.proofCaptured = []);
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await getUserMedia(constraints);
    tracks.push(...stream.getTracks());
    return stream;
  };
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function (...args) {
    const copy = clone.apply(this, args);
    tracks.push(copy);
    return copy;
  };
}

const captured = (page) =>
  page.evaluate(() => {
    const live = window.proofCaptured.filter((track) => track.readyState === "live");
    return { live: live.length, audio: live.filter((track) => track.kind === "audio").length, video: live.filter((track) => track.kind === "video").length };
  });

const survivorView = (page, leaver) =>
  page.evaluate((id) => {
    const snapshot = window.proofClient.getSnapshot();
    return {
      rosterWithoutLeaver: !snapshot.participants.roster.some((entry) => entry.participantId === id),
      remoteWithoutLeaver: !snapshot.media.remote.some((entry) => entry.participantId === id),
    };
  }, leaver);

// Two guests join on the own SFU with the current client. One leaves: the Sync acknowledgement arrives in time, its microphone and
// camera are released, the other guest drops it from the roster and from its received media, keeps its own capture, and the Episode lives on.
export async function leaveOwnSfuProof(run) {
  const receiver = await prepareIntegration(run, false);
  const space = await createSpace(run);
  const path = `${run.tenantPath}/spaces/${space.id}/episodes`;
  const episode = await run.apiRequest("POST", path, { metadata: { proof_run_id: run.runId } });
  await trackEpisode(run, space, episode);
  const guests = await launchGuests(run, space, episode, null, receiver.origin, true, 2, { observeLeave: true, pageProbe: installCaptureTracking });
  const [leaver, survivor] = guests.pages;
  await save(`${run.directory}/initial-media-progress.json`, await waitForMediaProgress(guests.pages));
  const leaverId = guests.participants[0];
  const before = await captured(leaver);
  const leaveBegan = performance.now();
  const leave = await measureLeave(leaver, "ordinary");
  await save(`${run.directory}/leave.json`, leave);
  // The release deadline runs from the start of the Leave, not from its acknowledgement. A wait that times out is not an error
  // here: the criteria below name what stayed behind.
  let after = await captured(leaver);
  const window = Math.max(0, releaseCeilingMs - (performance.now() - leaveBegan));
  if (after.live !== 0 && window > 0) await waitFor("the leaving guest's capture tracks end", async () => (after = await captured(leaver)).live === 0, window, 250).catch(() => {});
  const releaseMs = Math.round(performance.now() - leaveBegan);
  let view = await survivorView(survivor, leaverId);
  await waitFor("the other guest drops the guest who left", async () => (view = await survivorView(survivor, leaverId)).rosterWithoutLeaver && view.remoteWithoutLeaver, 30_000, 500).catch(() => {});
  const survivorTracks = await captured(survivor);
  const current = await run.apiRequest("GET", `${path}/${episode.id}`);
  const sample = {
    leave,
    capture: before,
    release: { ...after, ms: releaseMs },
    survivor: { ...view, ownTracksLive: survivorTracks.audio >= 1 && survivorTracks.video >= 1 },
    episodeStatus: current.status,
  };
  const evaluation = evaluateOwnSfuLeave(sample);
  await save(`${run.directory}/leave-own-sfu.json`, { ...sample, ...evaluation });
  await save(`${run.directory}/leave-comparison.json`, scorecardShape(sample, evaluation));
  console.log(`Own-SFU Leave: acknowledged in ${Math.round(leave.ms)} ms; capture released in ${releaseMs} ms; other guest dropped the leaver ${view.rosterWithoutLeaver && view.remoteWithoutLeaver}`);
  check(evaluation.passed, `Own-SFU Leave failed: ${evaluation.failures.join("; ")}`);
  return evaluation;
}
