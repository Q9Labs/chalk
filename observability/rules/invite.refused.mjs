// @ts-check
/**
 * invite.refused: the API refused an invite for a reason its own rows contradict. The refusal reasons stay server-side; the
 * client never receives one, so the client's failure screen is display only. A row "at the decision" means the current row when
 * its state_epoch equals the decision's input; otherwise the rule is unknown.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "invite.refused";

export const expected = "an invite refusal carries a reason the invite, Space, arrival and membership rows agree with";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "attempt";

/** @param {Observation} d */
const at = (d) => d.window.from_ms;

/**
 * @param {Observation} decision
 * @param {readonly Observation[]} rows
 * @param {readonly Observation[]} spaces
 * @param {readonly Observation[]} arrivals
 * @param {readonly Observation[]} members
 * @param {import("../../scripts/diagnose-call/proof/evidence.mjs").Window} window
 * @returns {Decision}
 */
function judge(decision, rows, spaces, arrivals, members, window) {
  const reason = /** @type {string | undefined} */ (decision.value.reason_code) ?? "unclassified";
  if (reason === "invite.not_found") return { status: "unknown", reason: "api invite code is never logged" };
  const epoch = decision.value.state_epoch;
  const row = rows.find((o) => o.value.state_epoch === epoch);
  if (!row) return { status: "unknown", reason: "db row changed since the decision" };
  const space = spaces[0];
  const decisionAt = at(decision);
  /** @param {string} text @param {readonly Observation[]} evidence */
  const broken = (text, evidence) => ({
    status: /** @type {const} */ ("finding"),
    outcome: /** @type {const} */ ("broken"),
    window,
    hop: "invite_resolve",
    module: "api.public_invites",
    reason: null,
    upstream: "witnessed",
    observed: `the API refused the invite ${reason}, but its own rows disagree`,
    facts: [
      { text: `invite.resolve refused reason=${reason} for ${decision.value.space_id ?? "spc_?"}`, evidence: [decision.id], window: decision.window, absent: null },
      { text, evidence: evidence.map((o) => o.id), window: evidence[0]?.window ?? window, absent: null },
    ],
    hypothesis: { text: "the resolve read a stale row or refused for a state the row no longer holds", falsified_by: "the row at the decision's state_epoch agreeing with the refusal" },
    falsify: { absence: null, attribution: "the row at the decision's state_epoch agreeing with the refusal" },
  });
  /** @param {string} text @param {readonly Observation[]} evidence */
  const expected = (text, evidence) => ({
    status: /** @type {const} */ ("finding"),
    outcome: /** @type {const} */ ("expected"),
    window,
    hop: null,
    module: null,
    reason,
    upstream: "witnessed",
    observed: `the API refused the invite ${reason} and its rows agree`,
    facts: [
      { text: `invite.resolve refused reason=${reason}`, evidence: [decision.id], window: decision.window, absent: null },
      { text, evidence: evidence.map((o) => o.id), window: evidence[0]?.window ?? window, absent: null },
    ],
    hypothesis: null,
    falsify: { absence: null, attribution: "the row at the decision's state_epoch contradicting the refusal" },
  });

  switch (reason) {
    case "invite.disabled": {
      if (row.claim === "false" && row.value.disabled_at != null && /** @type {number} */ (row.value.disabled_at) < decisionAt)
        return expected(`invite enabled=false disabled_at=${row.value.disabled_at} at the decision's state_epoch`, [row]);
      if (row.claim === "true" || row.value.disabled_at == null || /** @type {number} */ (row.value.disabled_at) > decisionAt)
        return broken(`invite enabled=${row.claim} disabled_at=${row.value.disabled_at ?? "null"} at the decision's state_epoch`, [row]);
      return expected("invite disabled before the decision", [row]);
    }
    case "invite.generation_mismatch":
    case "invite.invalid_row":
      return broken(`invite.resolve refused reason=${reason}; a matching handle with another generation has no legitimate cause`, [row]);
    case "invite.space_mismatch":
      return space ? broken(`spaces row tenant/space differs from the invite's at the decision`, [space, row]) : broken("no spaces row for the invite's ids", [row]);
    case "invite.space_archived": {
      if (!space) return { status: "unknown", reason: "no spaces row for the invite's ids" };
      if (space.value.archived_at != null && /** @type {number} */ (space.value.archived_at) < decisionAt) return expected(`spaces archived_at=${space.value.archived_at} before the decision`, [space]);
      if (space.value.archived_at == null && /** @type {number} */ (space.value.updated_at) < decisionAt) return broken(`spaces archived_at=null updated_at=${space.value.updated_at} before the decision`, [space]);
      return expected("the Space was archived around the decision", [space]);
    }
    case "invite.members_only": {
      const usr = decision.value.user_id;
      if (!usr) return expected("the decision carried no account", space ? [space] : []);
      const member = members.find((o) => o.value.user_id === usr && /** @type {number} */ (o.value.created_at) < decisionAt);
      if (member) return broken(`usr_ membership created at ${member.value.created_at} precedes the decision`, [member]);
      return expected("no memberships row for the decision's account", []);
    }
    case "invite.arrival_mismatch": {
      const arrival = arrivals.find((o) => o.value.arrival_handle === decision.value.arrival_handle);
      if (!arrival) return { status: "unknown", reason: "no arrival row for the decision's handle" };
      const rotated = row.value.rotated_at;
      if (
        arrival.value.invite_generation != null &&
        /** @type {number} */ (arrival.value.invite_generation) < /** @type {number} */ (row.value.invite_generation) &&
        rotated != null &&
        /** @type {number} */ (rotated) > /** @type {number} */ (arrival.value.created_at)
      )
        return expected("the arrival predates a rotation: an old link after rotation", [arrival, row]);
      return broken(`the arrival's invite_generation=${arrival.value.invite_generation ?? "?"} does not explain the mismatch (row generation ${row.value.invite_generation}, rotated_at ${rotated ?? "null"})`, [arrival, row]);
    }
    default:
      return { status: "unknown", reason: `undeclared refusal reason ${reason}` };
  }
}

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  for (const name of ["invite.decision", "invite.row", "invite.space", "invite.arrival", "invite.membership"]) {
    if (readings[name].kind === "unknown") return { status: "unknown", reason: `${name} not read` };
  }
  const decisions = readings["invite.decision"];
  if (decisions.kind !== "present") return { status: "pass" };
  const refused = decisions.observations.filter((o) => o.claim === "refused").sort((a, b) => a.window.from_ms - b.window.from_ms);
  if (refused.length === 0) return { status: "pass" };
  const rows = readings["invite.row"].kind === "present" ? readings["invite.row"].observations : [];
  const spaces = readings["invite.space"].kind === "present" ? readings["invite.space"].observations : [];
  const arrivals = readings["invite.arrival"].kind === "present" ? readings["invite.arrival"].observations : [];
  const members = readings["invite.membership"].kind === "present" ? readings["invite.membership"].observations : [];
  return judge(refused[refused.length - 1], rows, spaces, arrivals, members, window);
}
