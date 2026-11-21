// @ts-check
/**
 * recording.empty: a capture that reported success with no media committed (capture_empty). Broken at
 * capture_complete unless the SFU and the clients prove nobody published — then expected(recording.no_publication).
 * If the SFU was never read for a chalk_sfu Episode the check is unknown with the sfu gap, never healthy.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, asof, broken, captureJob, captureSent, expectedFinding, fact, field, jobRow, obs, pipelineRow, unknown } from "./recording.shared.mjs";

export const symptom = "recording.empty";
export const expected = "a capture that finishes commits media, or the SFU and the clients prove nobody published";
export const settle_ms = 60_000;
export const healthy_absent = ["recording.publication", "recording.participant_ingress", "recording.capture_transport"];

export const applies = captureJob;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = jobRow(readings);
  const pipeline = pipelineRow(readings);
  if (!job || !pipeline) return unknown("the job or pipeline row is not witnessed");
  const empty = field(job, "recording_error_code", "") === "capture_empty" ||
    (job.claim === "succeeded" && field(pipeline, "recording_media_bundles", null) === 0 && field(pipeline, "recording_gap_bundles", 0) === 0);
  if (!empty) return PASS;

  const sent = captureSent(readings);
  const ingress = obs(readings["recording.participant_ingress"])
    .filter((o) => field(o, "session_kind", "participant") === "participant")
    .reduce((sum, o) => sum + field(o, "recording_packets", 0), 0);
  const publications = obs(readings["recording.publication"]).filter((o) => field(o, "session_kind", "capture") !== "capture");
  const sessions = obs(readings["recording.session_register"]).filter((o) => field(o, "session_kind", "") === "participant");
  const publishes = obs(readings["recording.media_publish"]).filter((o) => field(o, "recording_media_action", "") === "publish" && o.claim === "succeeded");
  const mediaBundles = field(pipeline, "recording_media_bundles", 0);
  const at = field(job, "recording_terminal_ms", field(pipeline, "recording_capture_completed_ms", asof([job, pipeline])));

  if (sent > 0 || ingress > 0) {
    const module = sent > 0 ? "recorder.capture" : "sfu.media";
    return broken({
      hop: "capture_complete",
      module,
      observed: `capture_empty with media on the wire: capture session sent=${sent}, participant ingress packets=${ingress}, media_bundles=${mediaBundles}`,
      facts: [
        fact(`job ${job.claim} error_code=capture_empty`, [job]),
        fact(`pipeline media_bundles=${mediaBundles} gap_bundles=${field(pipeline, "recording_gap_bundles", 0)}`, [pipeline]),
        ...obs(readings["recording.capture_transport"]).map((o) => fact(`capture session sent_audio=${field(o, "recording_sent_audio", 0)} sent_video=${field(o, "recording_sent_video", 0)}`, [o])),
        ...obs(readings["recording.participant_ingress"]).map((o) => fact(`ingress ${field(o, "recording_media_kind", "?")} packets=${field(o, "recording_packets", 0)}`, [o])),
      ],
      at,
      evidence: [job, pipeline, ...obs(readings["recording.capture_transport"]), ...obs(readings["recording.participant_ingress"])],
    });
  }

  const sfuCovered = readings["recording.session_register"]?.kind === "present" ||
    (readings["recording.session_register"]?.kind === "absent" && readings["recording.publication"]?.kind === "absent");
  const clientCovered = readings["recording.media_publish"]?.kind !== "unknown";
  if (!publications.length && !publishes.length && sessions.length > 0 && clientCovered) {
    return expectedFinding({
      hop: "capture_complete",
      module: "recorder.capture",
      reason: "recording.no_publication",
      observed: `capture_empty and the node reported ${sessions.length} participant session(s) with no publication and no client publish`,
      facts: [
        fact(`job ${job.claim} error_code=capture_empty`, [job]),
        fact(`${sessions.length} participant session(s) reported, no sfu.publication.started`, sessions),
        fact("no media_result publish succeeded", [], "the client publish rows are absent"),
      ],
      at,
      evidence: [job, ...sessions],
    });
  }
  if (publications.length || publishes.length) {
    return broken({
      hop: "capture_complete",
      module: "sfu.media",
      observed: `capture_empty while ${publications.length + publishes.length} publication(s) were reported but no media reached the capture session`,
      facts: [
        fact(`job ${job.claim} error_code=capture_empty`, [job]),
        ...publications.map((o) => fact(`sfu.publication.started ${o.claim} on ${field(o, "participant_id", "?")}`, [o])),
        ...publishes.map((o) => fact(`media_result publish succeeded`, [o])),
      ],
      at,
      evidence: [job, ...publications, ...publishes],
    });
  }
  if (!sfuCovered || sessions.length === 0) return unknown("the SFU did not report the participant sessions: cannot prove nobody published");
  return unknown("the capture stayed empty and the evidence cannot place why");
}
