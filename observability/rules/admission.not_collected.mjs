// @ts-check
/**
 * admission.not_collected: the host approved, but the Guest's waiting page never collected the approval — the sweeper marked
 * the arrival admission_not_collected. The sweeper span and the row's terminal_reason are one decision; api status polls and
 * the client's own poll/pagehide facts are independent. A pagehide in phase=waiting before completion is the guest_left exit.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "admission.not_collected";

const poll_before_completed_ms = 10_000;

export const expected = "a waiting page either collects its approval or hides first and never polls again";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "episode";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const terminal = readings["admission.arrival_terminal"];
  const polls = readings["admission.status_poll"];
  const hides = readings["admission.pagehide"];
  if (terminal.kind === "unknown" || polls.kind === "unknown") return { status: "unknown", reason: "api incomplete" };
  if (terminal.kind !== "present") return { status: "pass" };
  const outcome = terminal.observations.find((o) => o.claim === "admission_not_collected") ?? terminal.observations[0];
  if (outcome.claim !== "admission_not_collected") return { status: "pass" };
  const completedAt = /** @type {number} */ (outcome.value.completed_at ?? outcome.window.from_ms);
  const handle = outcome.value.arrival_handle;

  const pollRows = (polls.kind === "present" ? polls.observations : []).filter((o) => o.value.arrival_handle === handle || o.source === "client").sort((a, b) => a.window.from_ms - b.window.from_ms);
  const hideRows = hides.kind === "present" ? hides.observations : [];
  const waitingHide = hideRows.find((o) => o.claim === "waiting" && o.window.from_ms < completedAt);
  const after = (o) => o.window.from_ms >= (waitingHide?.window.from_ms ?? completedAt);

  if (waitingHide && !pollRows.some(after)) {
    return {
      status: "finding",
      outcome: "expected",
      window: { from_ms: waitingHide.window.from_ms, to_ms: completedAt },
      hop: null,
      module: null,
      reason: "admission.guest_left",
      upstream: "witnessed",
      observed: "the waiting page hid before the approval and never polled again",
      facts: [{ text: "admission.pagehide phase=waiting", evidence: [waitingHide.id], window: waitingHide.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "a public.status from the arrival after the pagehide" },
    };
  }
  const lastPoll = pollRows.filter((o) => o.window.from_ms < completedAt).at(-1);
  const w = { from_ms: lastPoll ? lastPoll.window.to_ms + 1 : completedAt - poll_before_completed_ms, to_ms: completedAt };
  const facts = [
    { text: `approved ${lastPoll ? "after the last poll" : ""}`.trim() || "not collected", evidence: [outcome.id], window: outcome.window, absent: null },
  ];
  if (lastPoll) {
    facts.push({ text: `last public.status from the arrival`, evidence: [lastPoll.id], window: lastPoll.window, absent: null });
    facts.push({ text: "no public.status from the arrival after it", evidence: [], window: w, absent: "admission.status_poll" });
  }
  facts.push({ text: "not collected", evidence: [outcome.id], window: outcome.window, absent: null });
  return {
    status: "finding",
    outcome: "broken",
    window: w,
    hop: "client_network",
    module: "web.entrance",
    reason: null,
    upstream: "witnessed",
    observed: "the host approved but the Guest's waiting page never collected it",
    facts,
    hypothesis: { text: "the Guest's network or tab went away before the approval landed and the page never came back", falsified_by: "an admission.pagehide phase=waiting before completion, or polls that continued after it" },
    falsify: { absence: "a public.status from the arrival after completion", attribution: "a pagehide in an earlier phase" },
  };
}
