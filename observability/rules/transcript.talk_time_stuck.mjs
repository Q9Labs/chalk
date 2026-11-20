// @ts-check
/**
 * transcript.talk_time_stuck: talk-time answers `transcript_pending` for an Episode where no transcript can arrive.
 *
 * Judged on the Episode. db decides: it replays `transcriptInProgress` (apps/api/internal/talktime/service.go:177) over the
 * Episode's Recordings — a Recording is in progress when its transcription is `preparing`, `transcribing`, `verifying` or
 * `retryable_failure` and not deleted, when it is `not_requested` under automatic mode on a live Recording, or when it has no
 * transcription at all under automatic mode on a live Recording. BROKEN when no Recording has a `complete` transcription, at
 * least one Recording is in progress, and every in-progress Recording has been dead for at least 10 minutes:
 *
 * - (a) automatic, Recording `completed`, no transcription row, and the latest `recording_jobs` kind `transcription` row is
 *   `terminal_failure` or `cancelled` with `terminal_at <= asof - 10 min`, or there is no such row and `completed_at <= asof - 10
 *   min`; or
 * - (b) the transcription sits `preparing`, `transcribing`, `verifying` or `retryable_failure` with no open job and
 *   `updated_at <= asof - 10 min`.
 *
 * A Recording in `pending` or `processing` is in progress, not dead. The api `transcript.talk_time_served` row is the independent
 * witness: a served status that contradicts the db claim disagrees in the kernel, and `api` not read leaves its gap while db
 * still decides. Hop `serve`, module `api.talktime`.
 */
import { field, obs, unknown } from "./transcript.shared.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "transcript.talk_time_stuck";

export const expected = "talk_time reports transcript_pending only while a transcript can still arrive";

const DEAD_MS = 600_000;
const MID_FLIGHT = new Set(["preparing", "transcribing", "verifying", "retryable_failure"]);
const LIVE_RECORDING = new Set(["recording", "processing", "finalizing", "completed"]);

/** The episode item's window already runs to the read instant; nothing arrives past it that this check must wait for. */
export const settle_ms = 0;

/** @param {Declaration} declaration */
export const applies = (declaration, seat) => seat === null && declaration.kind === "episode";

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const talk = readings["transcript.talk"];
  if (talk.kind !== "present") return unknown("the talk-time read is not witnessed");
  const dbTalk = talk.observations.find((o) => o.source === "db");
  if (dbTalk === undefined) return unknown("the db talk-time recompute is not witnessed");
  const recordings = obs(readings["transcript.recording"]);
  const rows = obs(readings["transcript.row"]);
  const preps = obs(readings["transcript.prep"]);
  if (readings["transcript.recording"]?.kind === "unknown") return unknown("the Episode's Recordings are not witnessed");
  if (readings["transcript.row"]?.kind === "unknown") return unknown("the Episode's transcription rows are not witnessed");
  if (readings["transcript.prep"]?.kind === "unknown") return unknown("the Episode's preparation jobs are not witnessed");
  const at = Math.max(dbTalk.window.to_ms, ...rows.map((o) => o.window.to_ms), ...preps.map((o) => o.window.to_ms));

  const rowFor = (/** @type {string} recId */ recId) => rows.find((o) => field(o, "recording_id", "") === recId && field(o, "transcript_exists", true) === true && o.claim !== "none");
  const prepFor = (/** @type {string} recId */ recId) => preps.filter((o) => field(o, "recording_id", "") === recId && field(o, "transcript_exists", true) === true && o.claim !== "none").sort((a, b) => a.window.to_ms - b.window.to_ms).at(-1);

  const inProgress = (/** @type {Readonly<Observation>} rec */ rec) => {
    const recId = /** @type {string} */ (field(rec, "recording_id", rec.subject.job ?? ""));
    const row = rowFor(recId);
    const automatic = field(rec, "transcript_mode", "disabled") === "automatic";
    const live = LIVE_RECORDING.has(/** @type {string} */ (rec.claim));
    if (row !== undefined) {
      if (MID_FLIGHT.has(/** @type {string} */ (row.claim))) return field(row, "transcript_deleted", false) !== true;
      if (row.claim === "not_requested") return automatic && live;
      return false;
    }
    return automatic && live;
  };

  const dead = (/** @type {Readonly<Observation>} rec */ rec) => {
    const recId = /** @type {string} */ (field(rec, "recording_id", ""));
    const row = rowFor(recId);
    const automatic = field(rec, "transcript_mode", "disabled") === "automatic";
    if (["pending", "processing"].includes(/** @type {string} */ (rec.claim))) return false;
    if (row === undefined) {
      if (!automatic || rec.claim !== "completed") return false;
      const prep = prepFor(recId);
      if (prep !== undefined) return ["terminal_failure", "cancelled"].includes(/** @type {string} */ (prep.claim)) && /** @type {number} */ (field(prep, "transcript_terminal_ms", Number.POSITIVE_INFINITY)) <= at - DEAD_MS;
      return /** @type {number} */ (field(rec, "transcript_completed_ms", Number.POSITIVE_INFINITY)) <= at - DEAD_MS;
    }
    return MID_FLIGHT.has(/** @type {string} */ (row.claim)) && /** @type {number} */ (field(row, "transcript_open_jobs", 0)) === 0 && /** @type {number} */ (field(row, "transcript_updated_ms", Number.POSITIVE_INFINITY)) <= at - DEAD_MS;
  };

  const pending = recordings.filter((rec) => inProgress(rec));
  const anyComplete = rows.some((o) => o.claim === "complete" && field(o, "transcript_deleted", false) !== true);
  const stuck = pending.filter((rec) => dead(rec));
  if (anyComplete || pending.length === 0 || stuck.length < pending.length) return { status: "pass" };

  const deadFacts = stuck.map((rec) => {
    const recId = /** @type {string} */ (field(rec, "recording_id", ""));
    const row = rowFor(recId);
    const prep = prepFor(recId);
    const why = row === undefined ? (prep !== undefined ? `preparation ${prep.claim}` : `completed ${Math.round((at - /** @type {number} */ (field(rec, "transcript_completed_ms", at))) / 60000)} min ago, no transcription`) : `transcription ${row.claim}, no open job`;
    return { text: `Recording ${recId}: ${why}, dead ${Math.round((at - Math.min(/** @type {number} */ (field(row ?? prep ?? rec, row === undefined ? (prep === undefined ? "transcript_completed_ms" : "transcript_terminal_ms") : "transcript_updated_ms", at)), at)) / 60000)} min`, evidence: [rec.id, ...(row ? [row.id] : []), ...(prep ? [prep.id] : [])], window: rec.window, absent: null };
  });
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(...stuck.map((rec) => rec.window.from_ms), at), to_ms: at },
    hop: "serve",
    module: "api.talktime",
    reason: null,
    upstream: "witnessed",
    observed: `talk_time is transcript_pending for ${pending.length} Recording${pending.length > 1 ? "s" : ""}; every one is dead, no transcript can arrive`,
    facts: [{ text: `talk_time ${dbTalk.claim} (${field(dbTalk, "transcript_in_progress", 0)} in progress)`, evidence: [dbTalk.id], window: dbTalk.window, absent: null }, ...deadFacts],
    hypothesis: null,
    falsify: { absence: null, attribution: "an open job or a non-terminal transcription for a pending Recording" },
  };
}
