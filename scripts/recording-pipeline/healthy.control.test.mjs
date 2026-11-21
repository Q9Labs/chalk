// @ts-check
/**
 * Healthy control for slice 10: a fully witnessed capture+render world on the isolated Postgres —
 * the capture claims inside the bound, commits media bundles, the render commits an MP4 whose real
 * bytes pass the readback, the mint is used inside its lifetime and the player progresses without
 * error. Every slice-10 rule must return pass; a finding here means a rule fires on health.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { commitObject, containerUp, decideFor, readbackRows, seed, world, R, T0 } from "./fault.helper.mjs";

const captureRules = [
  "recording.never_captured",
  "recording.capture_failed",
  "recording.missing_span",
  "recording.empty",
  "recording.stuck",
];
const renderRules = [
  "render.failed",
  "recording.artifact_unreadable",
  "playback.url_expired",
  "playback.decode_failed",
  "recording.not_ready",
  "recording.stuck",
];

test("healthy control: no slice-10 rule finds a fault in a healthy capture", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId } = seed({
    jobState: "succeeded", attemptCount: 1, terminalMs: T0 + 600000, claimLagMs: 5000,
    pipelineState: "committed", mediaBundles: 3, gapBundles: 0, completeness: "complete",
  });
  world({
    logs: {
      "sfu.log": [
        { event: "sfu.session.registered", session_kind: "participant", participant_id: "p1", est_server_ms: T0 + 60000 },
        { event: "sfu.session.registered", session_kind: "capture", participant_id: "capture1", est_server_ms: T0 + 61000 },
        { event: "sfu.publication.started", session_kind: "participant", participant_id: "p1", recording_media_source: "camera", claim: "camera", est_server_ms: T0 + 62000 },
        { event: "sfu.media.ingress", session_kind: "participant", participant_id: "p1", recording_media_kind: "video", recording_packets: 1200, est_server_ms: T0 + 100000 },
        { event: "sfu.media.transport", session_kind: "capture", participant_id: "capture1", recording_sent_audio: 800, recording_sent_video: 1200, est_server_ms: T0 + 100000 },
        { event: "sfu.session.closed", session_kind: "capture", participant_id: "capture1", recording_session_outcome: "completed", est_server_ms: T0 + 590000 },
      ],
    },
  });
  for (const name of captureRules) {
    const rule = await import(`../../observability/rules/${name}.mjs`);
    const { decision } = await decideFor(jobId, rule);
    assert.equal(decision.status, "pass", `${name} reported ${decision.status}: ${decision.observed ?? decision.reason ?? ""}`);
  }
});

test("healthy control: no slice-10 rule finds a fault in a healthy render+playback", { skip: !containerUp() && "isolated postgres is not running" }, async () => {
  const { jobId, recordingId } = seed({
    kind: "render", jobState: "succeeded", attemptCount: 1, terminalMs: T0 + 900000,
    pipelineState: "committed", recordingStatus: "completed", artifact: { complete: true },
  });
  const { r2Dir } = world({
    objects: { "obj/k": { mp4: { seconds: 2 } } },
    logs: {
      "api.log": [
        { event: "playback.url_minted", recording_id: R, playback_signed_ms: T0 + 960000, playback_expires_ms: T0 + 960000 + 3600000, mint_count: 1, est_server_ms: T0 + 960000 },
      ],
      "web.log": [
        { event: "playback.progressed", recording_id: R, player_id: "pl1", playback_progress_ms: 1500, url_age_ms: 30000, url_lifetime_ms: 3600000, mint_count: 1, est_server_ms: T0 + 990000 },
      ],
    },
  });
  commitObject(recordingId, jobId, "obj/k", r2Dir);
  const extra = readbackRows(recordingId, jobId);
  assert.equal(extra[0]?.recording_r2_result, "ok", "the healthy object's readback must be ok");
  for (const name of renderRules) {
    const rule = await import(`../../observability/rules/${name}.mjs`);
    const { decision } = await decideFor(jobId, rule, { extra });
    assert.equal(decision.status, "pass", `${name} reported ${decision.status}: ${decision.observed ?? decision.reason ?? ""}`);
  }
});
