// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { seconds } from "./call.mjs";
import { cause, finding } from "./finding.mjs";
import { attr, number } from "./rows.mjs";

/** The join step that failed first (the innermost one) and whose side owns it. */
const JOIN_STEP_SIDES = { acquire_initial_media: "client", access_initialize: "API", create_media_client: "SFU", start_media: "SFU", create_sync_client: "Sync", start_sync: "Sync", wait_for_sync_live: "Sync", confirm_entered: "Sync" };
/** The step of the media path a report names when media failed. */
const MEDIA_STEP_SIDES = { local_capture: "client", peer_connection: "client", access_refresh: "API", sfu_tracks: "SFU", sfu_close_tracks: "SFU", sfu_renegotiate: "SFU", sfu_publications: "SFU", sfu_subscriptions: "SFU" };
/** How far a received audio track got before it stopped, and which side owns the next step. */
const RECEIVE_STOPS = {
  announced: ["the track was announced but the client never asked for it", "client"],
  pull_requested: ["the client asked for the track and got no answer", "SFU"],
  pull_failed: ["the client's request for the track failed", "SFU"],
  pull_succeeded: ["the track was pulled but never arrived", "SFU"],
  track_received: ["the track arrived but no bytes flowed", "SFU"],
  bytes_flowing: ["bytes flowed but the audio element did not play", "client"],
  element_bound: ["the audio element was bound but did not play", "client"],
};

/** The client report carries its events as a JSON string; a report that does not parse names no step. */
function reportOf(report) {
  try {
    const parsed = JSON.parse(String(attr(report, "report") ?? "{}"));
    return { trigger: attr(report, "trigger") ?? parsed.trigger, events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return { trigger: attr(report, "trigger"), events: [] };
  }
}

/** A 4xx answer is logged as `http.request` with its status; `http.failure` is the 5xx and transport case. */
const failedRequest = (row) => row.event === "http.failure" || (row.event === "http.request" && number(row, "status") >= 400);

function joinCause(rows, report, events) {
  const failure = rows.find((row) => failedRequest(row) && ((row.journey && row.journey === report.journey) || (row.trace && row.trace === report.trace)));
  if (failure) return { why: cause(`the API refused the request (${attr(failure, "error_code") ?? (number(failure, "status") ? `HTTP ${number(failure, "status")}` : "code not logged")})`, "joining", "API"), proof: [report, failure] };
  const step = events.find((event) => event.event === "space_join_span" && event.outcome === "failed" && event.step in JOIN_STEP_SIDES);
  if (step) return { why: cause(`the join failed at ${step.step} (${step.code ?? "code not logged"}) after ${seconds(step.duration_ms ?? 0)} s`, "joining", JOIN_STEP_SIDES[step.step]), proof: [report] };
  return { why: cause("unknown: no failed API request shares the report's journey id and the report names no failed step", "joining", "unknown"), proof: [report] };
}

/** One finding per failed join. */
function failedJoin(call, report, events) {
  const { why, proof } = joinCause(call.rows, report, events);
  return [finding("failed_join", report.participant, report.time, report.time, "could not join", why, proof)];
}

/** One finding per audio track the viewer could not hear, named by how far the receive got. */
function stuckAudio(_call, report, events) {
  return events
    .filter((event) => event.event === "audio_receive_stuck" && ["microphone", "screen_audio"].includes(event.source))
    .map((stuck) => {
      const [stop, side] = RECEIVE_STOPS[stuck.receive_state] ?? [`the furthest receive state was ${stuck.receive_state ?? "not logged"}`, "unknown"];
      const detail = [stuck.media_error_kind && stuck.media_error_kind !== "unknown" ? `error ${stuck.media_error_kind}` : undefined, stuck.media_error_step ? `at ${stuck.media_error_step}` : undefined].filter(Boolean).join(" ");
      return finding("audio_stuck", report.participant, report.time, report.time, `could not hear the ${stuck.source.replace("_", " ")} for ${seconds(stuck.duration_ms ?? 0)} s`, cause(`${stop}${detail ? ` (${detail})` : ""}`, "receiving", side), [report]);
    });
}

function projectionMismatch(_call, report) {
  const why = cause("the client reports a publication that is on while its projection is off; the report does not say which side is wrong", "publishing", "unknown");
  return [finding("projection_mismatch", report.participant, report.time, report.time, "reported its published media projected off", why, [report])];
}

function lostConnection(_call, report, events) {
  const failed = events.findLast((event) => event.outcome === "failed" || event.code || event.media_error_step);
  const side = MEDIA_STEP_SIDES[failed?.media_error_step] ?? "client";
  const last = `the client's last failure was ${failed?.code ?? failed?.media_error_kind ?? "not logged"}${failed?.media_error_step ? ` at ${failed.media_error_step}` : ""}`;
  const experience = reportOf(report).trigger === "recovery_exhausted" ? "ran out of attempts to recover its connection" : "lost its connection";
  return [finding("connection_lost", report.participant, report.time, report.time, experience, cause(last, "reconnecting", side), [report])];
}

/** What a connection report says went wrong, by its trigger. */
const REPORT_RULES = { join_failed: failedJoin, audio_receive_stuck: stuckAudio, media_projection_mismatch: projectionMismatch, connection_lost: lostConnection, recovery_exhausted: lostConnection };

/** What the client itself reported: join failures, lost connections, audio it could not hear. */
export function clientReports(call) {
  return call.rows
    .filter((row) => row.event === "sdk.connection_report")
    .flatMap((report) => {
      const { trigger, events } = reportOf(report);
      return (REPORT_RULES[trigger] ?? (() => []))(call, report, events);
    });
}
