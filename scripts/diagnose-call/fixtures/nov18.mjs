// @ts-check
/**
 * The 18 Nov world: the worked example from docs/plans/hyper-observability (c-compact.txt as the reviewer corrected it), and the
 * items around it that `day`, `check`, `participant` and lookup need. Every name, id and number is invented.
 *
 * - ep_9feb (TH, 14:45 local, 60 min, 4 seats): Haris unmuted at +07:10 for 3.5 min while SFU ingress counted 10480 packets and
 *   0 voiced; Sana reported "Haris's audio not audible" at +11:30; the time limit ended the Episode and Zara's leave failed 2 s later;
 *   the clients (3.1.0) cannot emit board camera evidence. Checked, current, broken, coverage partial(board).
 * - ep_7a21: never checked. Healthy once someone checks it.
 * - ep_31aa: checked healthy in the morning; a problem report arrived later, so it is stale, and a recheck finds a BLIND_SPOT.
 * - ep_5c0d: checked, healthy.
 * - an attempt that never got an admission decision (admission.unresolved, broken).
 * - ep_9feb's recording job, still pending 14 h later (recording.not_ready, degraded, open).
 * - ep_2d4e on 11 Nov: Haris silent again, so `participant` shows a pattern across days.
 * - a second Haris in tenant AB, so the name alone is ambiguous.
 */
import { origin } from "../proof/evidence.mjs";

/** @typedef {import("../proof/fixture-world.mjs").World} World */
/** @typedef {import("../proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../proof/evidence.mjs").Watermark} Watermark */
/** @typedef {import("../proof/profile.mjs").Seat} Seat */

const at = (/** @type {string} */ iso) => Date.parse(iso);
export const ASOF = at("2026-11-19T01:00:00Z");

const TH = "1f0c3b2a-7d6e-4c5b-9a8f-2e1d0c9b8a7f";
const AB = "a8b7c6d5-e4f3-4a2b-9c1d-0e9f8a7b6c5d";

/** User ids are tenant-supplied tokens (C1 `user` is canonical `token`), so their handles print in full. */
export const PEOPLE = Object.freeze({
  haris: { kind: /** @type {const} */ ("user"), id: "th-1041", name: "Haris", tenant: TH },
  sana: { kind: /** @type {const} */ ("user"), id: "th-1042", name: "Sana", tenant: TH },
  zara: { kind: /** @type {const} */ ("user"), id: "th-1043", name: "Zara", tenant: TH },
  omar: { kind: /** @type {const} */ ("user"), id: "th-1044", name: "Omar", tenant: TH },
  ayesha: { kind: /** @type {const} */ ("user"), id: "th-1045", name: "Ayesha", tenant: TH },
  harisAB: { kind: /** @type {const} */ ("user"), id: "ab-2001", name: "Haris", tenant: AB },
  lina: { kind: /** @type {const} */ ("user"), id: "ab-2002", name: "Lina", tenant: AB },
});

export const IDS = Object.freeze({
  tenant: TH,
  space: "5bace000-1c2d-4e3f-8a4b-5c6d7e8f9a01",
  ep9feb: "9feb0ff6-3c1a-4e7b-9a52-0d4c8e1f2a77",
  ep7a21: "7a21c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  ep31aa: "31aa4b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
  ep5c0d: "5c0d6e7f-8a9b-4c0d-8e1f-2a3b4c5d6e7f",
  ep2d4e: "2d4e8f9a-0b1c-4d2e-9f3a-4b5c6d7e8f9a",
  epe0f1: "e0f1a2b3-c4d5-4e6f-8a7b-9c0d1e2f3a4b",
  attempt: "6d5e4f3a-2b1c-4d0e-9f8a-7b6c5d4e3f2a",
  job: "4a3b2c1d-0e9f-4a8b-7c6d-5e4f3a2b1c0d",
  ptHaris: "4c1e9b7a2f3d5e6c8b0a1d2e3f4a5b6c",
  ptSana: "b2d4f6a8c0e2a4c6e8a0b2c4d6e8f0a2",
  ptBilal: "e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5",
  ptZara: "77b1c0e9d8f7a6b5c4d3e2f1a0b9c8d7",
  csHaris: "3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7",
  mediaHaris: "8f2c1a0b9e8d7c6b5a4f3e2d1c0b9a8f",
  evMic: "c9d0b1a2-3c4d-4e5f-9a6b-7c8d9e0f1a2b",
  evIngress: "a1f3e0c2-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
  evEnd: "0b9e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a",
  evLeave: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  evReport: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  evLateReport: "f4e5d6c7-b8a9-4f0e-8d1c-2b3a4f5e6d7c",
});

const CLIENT_BUILD = "client 3.1.0";
const CONTINUITY = ["access.grant_check", "reconnect.sync_check", "reconnect.media_check", "background.resume_check"];
const CLIENT_EMITS = Object.freeze(["audio.mic_state", "join.leave", "end.client_screen", ...CONTINUITY]);

/** @param {string} episode @param {readonly Seat[]} seats @param {number} checkedAt */
function continuity(episode, seats, checkedAt) {
  return seats.flatMap(({ participant }, seatIndex) =>
    CONTINUITY.map((fact, checkIndex) =>
      row(`${episode.slice(0, 8)}-ca0e-4000-8000-${String(seatIndex * CONTINUITY.length + checkIndex + 1).padStart(12, "0")}`, {
        fact,
        source: "client",
        origin: origin.measured("client", participant),
        subject: { episode, participant, generation: 1, connection: connectionOf(participant) },
        window: { from_ms: checkedAt, to_ms: checkedAt },
        claim: "verified",
        value: {},
        failure: false,
      }),
    ),
  );
}

/**
 * @param {string} participant
 * @param {string} name
 * @param {import("../proof/profile.mjs").Person} person
 * @param {{ from_ms: number, to_ms: number }} window
 * @param {{ role?: string, can_publish?: boolean }} [options]
 * @returns {Seat}
 */
function seat(participant, name, person, window, { role = "participant", can_publish = true } = {}) {
  return { participant, name, role, can_publish, generations: [1], connections: [connectionOf(participant)], window, person };
}

/** Each seat's one media connection. */
const connectionOf = (/** @type {string} */ participant) => `mc-${participant}`;

/** @param {{ kind: "user" | "agent", id: string, name: string }} p @returns {import("../proof/profile.mjs").Person} */
const user = (p) => ({ kind: p.kind, id: p.id, name: p.name });

/**
 * @param {string} id
 * @param {Omit<Observation, "id" | "query">} rest
 * @returns {Observation}
 */
const row = (id, rest) => ({ id, ...rest, query: `axiom chalk-logs | where event_id == '${id}'` });

/** @param {string} episode @param {string} participant @param {string} id @param {number} from @param {number} to @param {"unmuted" | "muted"} claim */
const mic = (episode, participant, id, from, to, claim) =>
  row(id, { fact: "audio.mic_state", source: "client", origin: origin.measured("client", participant), subject: { episode, participant, generation: 1, connection: connectionOf(participant) }, window: { from_ms: from, to_ms: to }, claim, value: {}, failure: false });

/** @param {string} episode @param {string} participant @param {string} id @param {number} from @param {number} to @param {number} packets @param {number} voiced */
const ingress = (episode, participant, id, from, to, packets, voiced) =>
  row(id, { fact: "audio.ingress", source: "sfu", origin: origin.measured("sfu"), subject: { episode, participant, connection: connectionOf(participant) }, window: { from_ms: from, to_ms: to }, claim: voiced > 0 ? "voiced" : "silent", value: { packets, voiced }, failure: false });

/**
 * Complete watermarks for an ended Episode: whole-item API, SFU, Sync and report streams, and each seat's client.
 * @param {readonly string[]} participants
 * @param {number} complete_to_ms
 * @returns {Watermark[]}
 */
const episodeWatermarks = (participants, complete_to_ms) => [
  { source: "api", subject: "*", complete_to_ms: ASOF, evidence_gaps: [], emits: ["admission.decision"], build: "api 2026.11.18" },
  { source: "sfu", subject: "*", complete_to_ms: ASOF, evidence_gaps: [], emits: ["audio.ingress"], build: "sfu 2026.11.12" },
  { source: "sync", subject: "*", complete_to_ms: ASOF, evidence_gaps: [], emits: ["end.episode", "access.presence_renewal"], build: "sync 2026.11.18" },
  { source: "report", subject: "*", complete_to_ms: ASOF, evidence_gaps: [], emits: ["report.problem"], build: "api 2026.11.18" },
  ...participants.map((participant) => ({ source: "client", subject: `pt:${participant}`, complete_to_ms, evidence_gaps: [], emits: [...CLIENT_EMITS], build: CLIENT_BUILD })),
];

/**
 * A healthy two-seat media Episode: both seats unmuted and voiced. `extra` adds rows to the current evidence only.
 * @param {string} id
 * @param {string} tenant
 * @param {number} from
 * @param {number} minutes
 * @param {[typeof PEOPLE.omar, typeof PEOPLE.ayesha]} people
 */
function quietEpisode(id, tenant, from, minutes, people) {
  const to = from + minutes * 60_000;
  const seats = people.map((person, index) => seat(`${id.replaceAll("-", "").slice(0, 8)}${String(index).repeat(24)}`, person.name, user(person), { from_ms: from, to_ms: to }));
  const observations = [
    ...continuity(id, seats, from + 120_000),
    ...seats.flatMap((s, index) => [mic(id, s.participant, `${id.slice(0, 8)}-0000-4000-8000-00000000000${index * 2 + 1}`, from + 30_000, to - 30_000, "unmuted"), ingress(id, s.participant, `${id.slice(0, 8)}-0000-4000-8000-00000000000${index * 2 + 2}`, from + 30_000, to - 30_000, 24_000, 9_000)]),
  ];
  return {
    declaration: { kind: /** @type {const} */ ("episode"), id, tenant, features: ["media"], window: { from_ms: from, to_ms: to }, seats },
    evidence: {
      observations,
      watermarks: episodeWatermarks(
        seats.map((s) => s.participant),
        to + 130_000,
      ),
    },
  };
}

/** @returns {World} */
export function nov18() {
  const start = at("2026-11-18T09:45:00Z");
  const end = at("2026-11-18T10:45:00Z");
  const ep = IDS.ep9feb;
  const whole = { from_ms: start, to_ms: end };
  const seats = [
    seat(IDS.ptHaris, "Haris", user(PEOPLE.haris), whole, { role: "owner" }),
    seat(IDS.ptSana, "Sana", user(PEOPLE.sana), whole),
    seat(IDS.ptBilal, "Bilal", { kind: "guest", device: "dev-4471", name: "Bilal" }, whole, { role: "guest" }),
    seat(IDS.ptZara, "Zara", user(PEOPLE.zara), whole, { role: "observer", can_publish: false }),
  ];
  /** @type {Observation[]} */
  const observations = [
    ...continuity(ep, seats, start + 120_000),
    mic(ep, IDS.ptHaris, IDS.evMic, at("2026-11-18T09:52:10Z"), at("2026-11-18T09:55:40Z"), "unmuted"),
    ingress(ep, IDS.ptHaris, IDS.evIngress, at("2026-11-18T09:52:10Z"), at("2026-11-18T09:55:40Z"), 10_480, 0),
    mic(ep, IDS.ptSana, "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", at("2026-11-18T09:45:30Z"), at("2026-11-18T10:44:50Z"), "unmuted"),
    ingress(ep, IDS.ptSana, "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c", at("2026-11-18T09:45:30Z"), at("2026-11-18T10:44:50Z"), 176_000, 61_500),
    mic(ep, IDS.ptBilal, "8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e", at("2026-11-18T09:46:00Z"), at("2026-11-18T10:44:00Z"), "muted"),
    row(IDS.evEnd, { fact: "end.episode", source: "sync", origin: origin.measured("sync"), subject: { episode: ep }, window: { from_ms: end, to_ms: end }, claim: "maximum_duration", value: {}, failure: false }),
    row(IDS.evLeave, {
      fact: "join.leave",
      source: "client",
      origin: origin.measured("client", IDS.ptZara),
      subject: { episode: ep, participant: IDS.ptZara, generation: 1, connection: connectionOf(IDS.ptZara) },
      window: { from_ms: end + 2_000, to_ms: end + 2_000 },
      claim: "failed",
      value: { error: "socket_closed" },
      failure: true,
    }),
    row(IDS.evReport, {
      fact: "report.problem",
      source: "report",
      origin: origin.person(IDS.ptSana),
      subject: { episode: ep, participant: IDS.ptSana },
      window: { from_ms: at("2026-11-18T09:56:30Z"), to_ms: at("2026-11-18T09:56:30Z") },
      claim: "audio",
      value: { text: "Haris's audio not audible" },
      failure: false,
    }),
  ];
  const ep9feb = {
    declaration: { kind: /** @type {const} */ ("episode"), id: ep, tenant: TH, features: ["media", "board", "time_limit"], window: whole, seats },
    evidence: {
      observations,
      watermarks: episodeWatermarks(
        seats.map((s) => s.participant),
        end + 130_000,
      ),
    },
  };

  const ep7a21 = quietEpisode(IDS.ep7a21, TH, at("2026-11-18T11:00:00Z"), 30, [PEOPLE.omar, PEOPLE.ayesha]);
  const ep5c0d = quietEpisode(IDS.ep5c0d, TH, at("2026-11-18T04:00:00Z"), 30, [PEOPLE.omar, PEOPLE.ayesha]);
  const ep31aa = quietEpisode(IDS.ep31aa, TH, at("2026-11-18T06:00:00Z"), 45, [PEOPLE.omar, PEOPLE.ayesha]);
  const morning = structuredClone(ep31aa.evidence);
  const ayesha = ep31aa.declaration.seats[1].participant;
  ep31aa.evidence.observations.push(
    row(IDS.evLateReport, {
      fact: "report.problem",
      source: "report",
      origin: origin.person(ayesha),
      subject: { episode: IDS.ep31aa, participant: ayesha },
      window: { from_ms: at("2026-11-18T06:20:00Z"), to_ms: at("2026-11-18T06:20:00Z") },
      claim: "video",
      value: { text: "screen froze for everyone" },
      failure: false,
    }),
  );

  const ep2d4e = quietEpisode(IDS.ep2d4e, TH, at("2026-11-11T10:00:00Z"), 40, [PEOPLE.haris, PEOPLE.sana]);
  const harisSeat = ep2d4e.declaration.seats[0].participant;
  ep2d4e.evidence.observations = ep2d4e.evidence.observations.filter((o) => o.subject.participant !== harisSeat);
  ep2d4e.evidence.observations.push(
    mic(IDS.ep2d4e, harisSeat, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e", at("2026-11-11T10:05:00Z"), at("2026-11-11T10:06:30Z"), "unmuted"),
    ingress(IDS.ep2d4e, harisSeat, "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6f", at("2026-11-11T10:05:00Z"), at("2026-11-11T10:06:30Z"), 4_500, 0),
  );
  const epe0f1 = quietEpisode(IDS.epe0f1, AB, at("2026-11-17T08:00:00Z"), 30, [PEOPLE.harisAB, PEOPLE.lina]);

  const attemptWindow = { from_ms: at("2026-11-18T10:02:00Z"), to_ms: at("2026-11-18T10:02:40Z") };
  const attempt = {
    declaration: { kind: /** @type {const} */ ("attempt"), id: IDS.attempt, tenant: TH, window: attemptWindow },
    evidence: { observations: [], watermarks: [{ source: "api", subject: "*", complete_to_ms: ASOF, evidence_gaps: [], emits: ["admission.decision"], build: "api 2026.11.18" }] },
  };
  const job = {
    declaration: { kind: /** @type {const} */ ("job"), id: IDS.job, tenant: TH, episode: ep, job_kind: "recording", window: { from_ms: end, to_ms: null } },
    evidence: { observations: [], watermarks: [{ source: "db", subject: "*", complete_to_ms: ASOF, evidence_gaps: [], emits: ["recording.job_state"], build: "postgres" }] },
  };

  // One UTC day of a Space, of the tenant and of the platform. No check judges them yet (the slices add Space, Tenant and platform checks), so
  // they read as unchecked, never healthy.
  const utcDay = { from_ms: at("2026-11-18T00:00:00Z"), to_ms: at("2026-11-19T00:00:00Z") };
  const spaceDay = {
    declaration: { kind: /** @type {const} */ ("space"), id: IDS.space, tenant: TH, day: "2026-11-18", window: utcDay, episodes: [ep, IDS.ep7a21, IDS.ep5c0d, IDS.ep31aa] },
    evidence: { observations: [], watermarks: [] },
  };
  const tenantDay = {
    declaration: { kind: /** @type {const} */ ("tenant"), id: TH, tenant: TH, day: "2026-11-18", window: utcDay },
    evidence: { observations: [], watermarks: [] },
  };
  const platformDay = {
    declaration: { kind: /** @type {const} */ ("platform"), id: "production", tenant: null, day: "2026-11-18", window: utcDay },
    evidence: { observations: [], watermarks: [] },
  };

  const all = [ep9feb, ep7a21, ep5c0d, ep31aa, ep2d4e, epe0f1, attempt, job, spaceDay, tenantDay, platformDay];
  return {
    asof_ms: ASOF,
    tenants: [
      { id: TH, name: "TH", tz: "Asia/Karachi" },
      { id: AB, name: "AB", tz: "Asia/Dubai" },
    ],
    people: Object.values(PEOPLE),
    declarations: all.map((entry) => entry.declaration),
    sessions: [
      { id: IDS.csHaris, meaning: "client_session", episode: ep, participant: IDS.ptHaris },
      { id: IDS.mediaHaris, meaning: "provider_media", episode: ep, participant: IDS.ptHaris },
    ],
    evidence: Object.fromEntries(all.map((entry) => [entry.declaration.id, entry.evidence])),
    history: [
      { item: ep, asof_ms: ASOF, evidence: ep9feb.evidence },
      { item: IDS.ep5c0d, asof_ms: at("2026-11-18T05:00:00Z"), evidence: ep5c0d.evidence },
      { item: IDS.ep31aa, asof_ms: at("2026-11-18T07:00:00Z"), evidence: morning },
      { item: IDS.ep2d4e, asof_ms: at("2026-11-11T12:00:00Z"), evidence: ep2d4e.evidence },
      { item: IDS.epe0f1, asof_ms: at("2026-11-17T09:00:00Z"), evidence: epe0f1.evidence },
      { item: IDS.attempt, asof_ms: ASOF, evidence: attempt.evidence },
      { item: IDS.job, asof_ms: ASOF, evidence: job.evidence },
    ],
  };
}

export default nov18;
