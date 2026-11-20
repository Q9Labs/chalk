// @ts-check
/**
 * The checks. Each is one symptom code, the witnesses it needs, and a rule that states facts from those witnesses. A slice adds
 * its checks here (or in a file this list imports) with a positive fixture, a healthy fixture and a fault scenario, and adds the facts
 * its adapters emit to facts.mjs. The five below are the worked example; each covers a different shape:
 *
 * - `audio.no_voice_detected`: a per-seat chain across two independent witnesses (client microphone state, SFU ingress), with an
 *   optional upstream witness (capture level) that turns "upstream unknown" into an attributed hop and a hypothesis.
 * - `end.time_limit`: an item-wide `expected` rule with a tight causal precondition that claims the client failures it explains.
 * - `board.view_jumped`: a witness older builds cannot emit, so its absence is unknown, never "board unused".
 * - `recording.not_ready`: a pending post-call job.
 * - `entry.unresolved`: an attempt that never became an Episode.
 */
import { overlaps } from "./evidence.mjs";
import { rulesVersion } from "./verdict.mjs";

/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./profile.mjs").Fact} Fact */
/** @typedef {import("./evidence.mjs").Observation} Observation */

const AXIOM = "axiom chalk-logs";
/** Unmuted for less than this is too short to call silent. */
const SILENT_MIN_MS = 5_000;
/** A capture level above this is a voice, not the noise floor. */
const VOICE_DBFS = -50;
/** A client failure this close to a time-limit end is the end itself. */
const END_SLACK_MS = 10_000;
/** More automatic camera moves than this within two seconds is a jumping view. */
const JUMPS_PER_2S = 5;
/** A recording still not ready this long after the Episode ended is late. */
const RECORDING_READY_MS = 30 * 60_000;

/** @param {readonly Readonly<Observation>[]} list @param {string} name */
const sum = (list, name) => list.reduce((total, o) => total + Number(o.value[name] ?? 0), 0);
/** @param {Readonly<Observation>} o */
const evidence = (o) => [o.id];

/** @type {CheckDef} */
const noVoiceDetected = {
  code: "audio.no_voice_detected",
  item: "episode",
  per: "seat",
  applies: (declaration, seat) => declaration.kind === "episode" && declaration.features.includes("media") && seat !== null && seat.can_publish,
  requires: [
    { fact: "audio.mic_state", from: ["client"], query: `${AXIOM} | where episode_id == '{episode}' and participant_id == '{participant}' and event == 'sdk.mic_state' | where _time between (datetime({from}) .. datetime({to}))` },
    { fact: "audio.ingress", from: ["sfu"], query: `${AXIOM} | where episode_id == '{episode}' and participant_id == '{participant}' and event == 'sfu.media.ingress' and media_kind == 'audio' | where _time between (datetime({from}) .. datetime({to}))` },
  ],
  optional: [{ fact: "audio.capture", from: ["client"], query: "r2 flight-recorder/{episode}/{participant} mic_rms {from}..{to}" }],
  expected: `while the microphone is unmuted for ${SILENT_MIN_MS / 1000} s or more, voiced audio packets reach SFU ingress`,
  decide({ readings }) {
    const mic = readings["audio.mic_state"];
    const ingress = readings["audio.ingress"];
    const capture = readings["audio.capture"];
    if (mic.kind !== "present") return mic.kind === "absent" ? { status: "pass" } : { status: "unknown", reason: "microphone state not witnessed" };
    const unmuted = mic.observations.filter((o) => o.claim === "unmuted" && o.window.to_ms - o.window.from_ms >= SILENT_MIN_MS);
    if (ingress.kind === "unknown") return unmuted.length === 0 ? { status: "pass" } : { status: "unknown", reason: "SFU ingress not witnessed for the unmuted time" };
    const silent = unmuted.flatMap((u) => {
      const rollups = ingress.kind === "present" ? ingress.observations.filter((o) => overlaps(o.window, u.window)) : [];
      return rollups.length === 0 || sum(rollups, "voiced") === 0 ? [{ u, rollups }] : [];
    });
    if (silent.length === 0) return { status: "pass" };

    /** @type {Fact[]} */
    const facts = silent.flatMap(({ u, rollups }) => [
      rollups.length === 0 ? { text: "no audio packets at SFU ingress", evidence: [], window: u.window, absent: "audio.ingress" } : { text: `SFU ingress ${sum(rollups, "packets")} packets, 0 voiced`, evidence: rollups.map((o) => o.id), window: u.window, absent: null },
      { text: "microphone unmuted", evidence: evidence(u), window: u.window, absent: null },
    ]);
    const window = { from_ms: silent[0].u.window.from_ms, to_ms: /** @type {{ u: Readonly<Observation> }} */ (silent.at(-1)).u.window.to_ms };
    const levels = capture.kind === "present" && capture.complete ? capture.observations.filter((o) => overlaps(o.window, window)) : [];
    const packets = sum(
      silent.flatMap(({ rollups }) => rollups),
      "packets",
    );
    const base = { status: /** @type {const} */ ("finding"), outcome: /** @type {const} */ ("broken"), window, observed: `unmuted, ${packets} packets and 0 voiced at SFU ingress` };
    const falsifyAbsence = "a voiced audio rollup at SFU ingress inside the window";
    if (levels.length === 0) {
      return { ...base, hop: "sfu_ingress", upstream: "unknown", facts, hypothesis: null, falsify: { absence: falsifyAbsence, attribution: "audio.capture (the microphone level before WebRTC) is not witnessed, so which client hop failed is unproved" } };
    }
    const loudest = Math.max(...levels.map((o) => Number(o.value.rms_max_dbfs ?? -Infinity)));
    const level = { text: `capture level peaked at ${loudest} dBFS`, evidence: levels.map((o) => o.id), window, absent: null };
    if (loudest > VOICE_DBFS) {
      return {
        ...base,
        hop: "client_send",
        upstream: "witnessed",
        facts: [...facts, level],
        hypothesis: { text: "the sender dropped or replaced the captured track", falsified_by: "outbound RTP with voiced packets in the window" },
        falsify: { absence: falsifyAbsence, attribution: `a capture level at or below ${VOICE_DBFS} dBFS` },
      };
    }
    return {
      ...base,
      hop: "client_capture",
      upstream: "witnessed",
      facts: [...facts, level],
      hypothesis: { text: "a wrong or muted input device", falsified_by: "the active input device label matching the one the Participant spoke into" },
      falsify: { absence: falsifyAbsence, attribution: `a capture level above ${VOICE_DBFS} dBFS` },
    };
  },
};

/** @type {CheckDef} */
const endTimeLimit = {
  code: "end.time_limit",
  item: "episode",
  per: "item",
  applies: (declaration) => declaration.kind === "episode" && declaration.features.includes("time_limit"),
  requires: [{ fact: "episode.end", from: ["api"], query: `${AXIOM} | where episode_id == '{episode}' and event == 'decision' and name == 'episode.end'` }],
  optional: [],
  expected: "an Episode stopped by its time limit ends by an API decision with reason time_limit, and any client failure within 10 s of that end is the end itself",
  decide({ readings, failures }) {
    const end = readings["episode.end"];
    if (end.kind !== "present") return { status: "pass" };
    const decision = end.observations.find((o) => o.claim === "time_limit");
    if (!decision) return { status: "pass" };
    const at = decision.window.from_ms;
    const near = failures.filter((o) => Math.abs(o.window.from_ms - at) <= END_SLACK_MS);
    /** @type {Fact[]} */
    const facts = [{ text: "API ended the Episode: time_limit", evidence: evidence(decision), window: decision.window, absent: null }, ...near.map((o) => ({ text: `${o.fact} ${o.claim}, within ${END_SLACK_MS / 1000} s of the end`, evidence: evidence(o), window: o.window, absent: null }))];
    return {
      status: "finding",
      outcome: "expected",
      window: decision.window,
      hop: null,
      upstream: null,
      observed: `ended by time_limit; ${near.length} client failures within ${END_SLACK_MS / 1000} s claimed by the end`,
      facts,
      hypothesis: null,
      falsify: { absence: null, attribution: `an end decision with another reason, or a failure more than ${END_SLACK_MS / 1000} s from the end` },
    };
  },
};

/** @type {CheckDef} */
const boardViewJumped = {
  code: "board.view_jumped",
  item: "episode",
  per: "seat",
  applies: (declaration, seat) => declaration.kind === "episode" && declaration.features.includes("board") && seat !== null,
  requires: [{ fact: "board.camera", from: ["client"], query: "r2 flight-recorder/{episode}/{participant} board_camera {from}..{to}" }],
  optional: [],
  expected: `a viewer's board camera moves automatically at most ${JUMPS_PER_2S} times in any 2 s`,
  decide({ readings }) {
    const camera = readings["board.camera"];
    if (camera.kind === "unknown") return { status: "unknown", reason: "viewer camera evidence not witnessed" };
    const automatic = camera.kind === "present" ? camera.observations.filter((o) => o.claim !== "user_pan").sort((a, b) => a.window.from_ms - b.window.from_ms) : [];
    for (let start = 0; start + JUMPS_PER_2S < automatic.length; start += 1) {
      const burst = automatic.slice(start, start + JUMPS_PER_2S + 1);
      const window = { from_ms: burst[0].window.from_ms, to_ms: /** @type {Readonly<Observation>} */ (burst.at(-1)).window.to_ms };
      if (window.to_ms - window.from_ms > 2_000) continue;
      return {
        status: "finding",
        outcome: "degraded",
        window,
        hop: "board_follow",
        upstream: "witnessed",
        observed: `${burst.length} automatic camera moves within 2 s`,
        facts: [{ text: `${burst.length} automatic camera moves (${[...new Set(burst.map((o) => o.claim))].join(", ")})`, evidence: burst.map((o) => o.id), window, absent: null }],
        hypothesis: null,
        falsify: { absence: null, attribution: "the moves were caused by the viewer (user_pan)" },
      };
    }
    return { status: "pass" };
  },
};

/** @type {CheckDef} */
const recordingNotReady = {
  code: "recording.not_ready",
  item: "job",
  per: "item",
  applies: (declaration) => declaration.kind === "job" && declaration.job_kind === "recording",
  requires: [{ fact: "job.terminal", from: ["db"], query: "postgres: select state, updated_at from recording_jobs where id = '{job}'" }],
  optional: [],
  expected: `a recording job reaches a terminal state within ${RECORDING_READY_MS / 60_000} min, and the state is succeeded`,
  decide({ readings, window }) {
    const terminal = readings["job.terminal"];
    if (terminal.kind === "unknown") return { status: "unknown", reason: "job state not read" };
    if (terminal.kind === "present") {
      const failed = terminal.observations.find((o) => o.claim !== "succeeded");
      if (!failed) return { status: "pass" };
      return {
        status: "finding",
        outcome: "broken",
        window: failed.window,
        hop: "recorder",
        upstream: "unknown",
        observed: `job ended ${failed.claim}`,
        facts: [{ text: `job ended ${failed.claim}`, evidence: evidence(failed), window: failed.window, absent: null }],
        hypothesis: null,
        falsify: { absence: null, attribution: "a later succeeded state for the same job" },
      };
    }
    if (window.to_ms - window.from_ms <= RECORDING_READY_MS) return { status: "unknown", reason: `pending for less than ${RECORDING_READY_MS / 60_000} min` };
    return {
      status: "finding",
      outcome: "degraded",
      window,
      hop: "recorder",
      upstream: "unknown",
      observed: `no terminal state ${Math.round((window.to_ms - window.from_ms) / 60_000)} min after the Episode ended`,
      facts: [{ text: "no terminal job state", evidence: [], window, absent: "job.terminal" }],
      hypothesis: null,
      falsify: { absence: "a terminal state row for the job inside the window", attribution: null },
    };
  },
};

/** @type {CheckDef} */
const entryUnresolved = {
  code: "entry.unresolved",
  item: "attempt",
  per: "item",
  applies: () => true,
  requires: [{ fact: "entry.decision", from: ["api"], query: `${AXIOM} | where journey_id == '{attempt}' and event == 'decision' and name == 'admission'` }],
  optional: [],
  expected: "every join attempt ends in an admission decision (admitted or refused with a reason)",
  decide({ readings, window }) {
    const decision = readings["entry.decision"];
    if (decision.kind !== "absent") return decision.kind === "present" ? { status: "pass" } : { status: "unknown", reason: "admission decisions not read" };
    return {
      status: "finding",
      outcome: "broken",
      window,
      hop: "api_admission",
      upstream: "unknown",
      observed: "the attempt never got an admission decision",
      facts: [{ text: "no admission decision", evidence: [], window, absent: "entry.decision" }],
      hypothesis: null,
      falsify: { absence: "an admission decision row for this journey", attribution: null },
    };
  },
};

/** @type {readonly CheckDef[]} */
export const CATALOGUE = Object.freeze([noVoiceDetected, endTimeLimit, boardViewJumped, recordingNotReady, entryUnresolved]);
export const RULES = rulesVersion(CATALOGUE);
