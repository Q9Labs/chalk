// @ts-check
/**
 * embed.blocked: the embed got access grants, but nothing sent under them reached Chalk — the host page's policy blocks the
 * connection, and a blocked embed can't report itself either. A grant is unused when its Participant has no
 * sync.websocket.authenticated (matched by participant_id_hash, computed as socket_context.ex computes it) and no api request
 * on a route naming it, within 60 s of issue. Two or more unused grants in a Tenant inside 5 min is broken; one is not.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

import { createHash } from "node:crypto";

export const symptom = "embed.blocked";

const embed_auth_ms = 60_000;
const embed_window_ms = 300_000;
const min_unused = 2;
const GRANT_ROUTE = "/v1/tenants/:tenant_id/participants/:participant_id/access-grants";

export const expected = "every issued access grant sees its Participant reach Chalk through sync or the api within 60 s";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "tenant";

/**
 * The canonical Participant id hashed exactly as apps/sync/lib/chalk_sync/transport/socket_context.ex:29-30 computes it:
 * a lowercase hex SHA-256 of the canonical id string.
 * @param {string} participantId
 */
export const participantIdHash = (participantId) => createHash("sha256").update(participantId).digest("hex");

/** @param {Observation} grant @param {readonly Observation[]} auths @param {readonly Observation[]} requests */
const unused = (grant, auths, requests) => {
  const pt = /** @type {string | undefined} */ (grant.subject.participant ?? grant.value.participant_id);
  if (!pt) return false;
  const at = grant.window.from_ms;
  const until = at + embed_auth_ms;
  if (auths.some((o) => o.claim === participantIdHash(pt) && o.window.from_ms >= at && o.window.from_ms <= until)) return false;
  return !requests.some((o) => o.subject.participant === pt && o.value.http_route !== GRANT_ROUTE && o.window.from_ms >= at && o.window.from_ms <= until);
};

/** @param {Observation} grant @param {readonly Observation[]} participants @param {readonly Observation[]} episodes */
const withdrawn = (grant, participants, episodes) => {
  const pt = /** @type {string | undefined} */ (grant.subject.participant ?? grant.value.participant_id);
  const until = grant.window.from_ms + embed_auth_ms;
  const row = participants.find((o) => o.subject.participant === pt);
  if (row && row.claim !== "active" && /** @type {number} */ (row.window.to_ms ?? row.window.from_ms) <= until) return true;
  const episode = episodes.find((o) => o.subject && row && o.value.episode_id === row.value.episode_id);
  return episode !== undefined && episode.claim === "ended" && /** @type {number} */ (episode.value.ended_at ?? episode.window.from_ms) <= until;
};

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const grants = readings["embed.grant"];
  const auths = readings["embed.sync_auth"];
  const requests = readings["embed.api_request"];
  const participants = readings["embed.participant"];
  const episodes = readings["embed.episode"];
  if (grants.kind === "unknown" || requests.kind === "unknown") return { status: "unknown", reason: "api 2xx not shipped" };
  if (auths.kind === "unknown") return { status: "unknown", reason: "sync incomplete" };
  if (grants.kind !== "present") return { status: "pass" };
  const grantRows = grants.observations.filter((o) => o.claim >= 200 && o.claim < 300);
  const authRows = auths.kind === "present" ? auths.observations : [];
  const requestRows = requests.kind === "present" ? requests.observations : [];
  const participantRows = participants.kind === "present" ? participants.observations : [];
  const episodeRows = episodes.kind === "present" ? episodes.observations : [];
  const unusedGrants = grantRows.filter((g) => unused(g, authRows, requestRows)).sort((a, b) => a.window.from_ms - b.window.from_ms);
  for (let i = 0; i + min_unused <= unusedGrants.length; i += 1) {
    const group = unusedGrants.slice(i, i + min_unused);
    if (group[min_unused - 1].window.from_ms - group[0].window.from_ms > embed_window_ms) continue;
    const window = { from_ms: group[0].window.from_ms, to_ms: group[min_unused - 1].window.from_ms + embed_auth_ms };
    if (group.every((g) => withdrawn(g, participantRows, episodeRows))) {
      return {
        status: "finding",
        outcome: "expected",
        window,
        hop: null,
        module: null,
        reason: "embed.grant_withdrawn",
        upstream: "witnessed",
        observed: "every unused grant's Participant was removed, or its Episode ended, within 60 s of issue",
        facts: [{ text: `${min_unused} access grants issued within 5 min, all withdrawn`, evidence: group.map((g) => g.id), window, absent: null }],
        hypothesis: null,
        falsify: { absence: null, attribution: "an unused grant whose Participant stayed active" },
      };
    }
    const latest = group[min_unused - 1];
    const until = { from_ms: latest.window.from_ms, to_ms: latest.window.from_ms + embed_auth_ms };
    return {
      status: "finding",
      outcome: "broken",
      window,
      hop: "host_csp",
      module: "react.embed",
      reason: null,
      upstream: "witnessed",
      observed: "the embed got access grants, but nothing sent under them reached Chalk",
      facts: [
        { text: `${min_unused} access grants issued within 5 min, the latest for ${latest.subject.participant ?? "pt_?"}`, evidence: group.map((g) => g.id), window, absent: null },
        { text: "no sync.websocket.authenticated for either grant's Participant within 60 s", evidence: [], window: until, absent: "embed.sync_auth" },
        { text: "the only api requests after either grant were the grant calls themselves", evidence: group.map((g) => g.id), window: until, absent: null },
      ],
      hypothesis: { text: "the host page's Content-Security-Policy blocks the api and sync origins", falsified_by: "a sync.websocket.authenticated or api request under the grant within 60 s of issue" },
      falsify: { absence: "a sync or api record under the grant within 60 s", attribution: "a grant issued to a different Tenant" },
    };
  }
  return { status: "pass" };
}
