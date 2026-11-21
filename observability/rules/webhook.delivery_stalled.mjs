// @ts-check
/**
 * webhook.delivery_stalled: a delivery sat pending, in retry_wait or claimed past the time it should have run again, so delivery
 * is late. A delivery held under a lease that expired long ago counts too. An API restart marker inside the stall window makes
 * the stall expected — the dispatcher is catching up — otherwise it is degraded.
 *
 * The witnesses are in areas/webhooks.json: `webhook.delivery`, `webhook.attempt` and `webhook.retry` from Postgres, and
 * `webhook.cycle` plus the `webhook.marker` API start markers from the API. A claimed delivery's due time is its lease expiry;
 * a pending or retry_wait delivery's is its `next_attempt_at_ms` (the retry ledger says it when the delivery row cannot).
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "webhook.delivery_stalled";

/** A retry may be this late against its schedule and still be normal backlog. */
const GRACE_MS = 30_000;
/** A restart explains a stall only while the catch-up it caused could still be running. */
const RESTART_CAUGHT_UP_MS = 120_000;

export const expected = "every delivery that is not terminal runs on or near its next attempt time";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "tenant";

/** @param {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} delivery @returns {number | null} */
const dueOf = (delivery) => {
  if (typeof delivery.value.next_attempt_at_ms === "number") return delivery.value.next_attempt_at_ms;
  if (delivery.value.delivery_state === "delivering" && typeof delivery.value.lease_expires_at_ms === "number") return delivery.value.lease_expires_at_ms;
  return typeof delivery.value.occurred_at_ms === "number" ? delivery.value.occurred_at_ms : null;
};

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const deliveries = readings["webhook.delivery"];
  const retry = readings["webhook.retry"];
  const cycles = readings["webhook.cycle"];
  const markers = readings["webhook.marker"];
  if (deliveries.kind === "unknown") return { status: "unknown", reason: "the tenant's deliveries are not fully read" };
  if (deliveries.kind === "absent") return { status: "pass" };
  if (retry.kind === "unknown") return { status: "unknown", reason: "the retry ledger is not fully read" };
  if (cycles.kind === "unknown" || markers.kind === "unknown") return { status: "unknown", reason: "the dispatch cycles and restarts are not fully read" };
  const now = window.to_ms;
  if (now === null) return { status: "unknown", reason: "an open tenant day has no time to judge lateness against" };

  const retries = retry.kind === "present" ? retry.observations : [];
  /** @param {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} delivery */
  const scheduled = (delivery) => {
    const scheduledAt = retries.filter((row) => row.value.webhook_delivery_id === delivery.value.webhook_delivery_id && typeof row.value.next_attempt_at_ms === "number").map((row) => row.value.next_attempt_at_ms);
    return scheduledAt.length > 0 ? Math.max(...scheduledAt) : dueOf(delivery);
  };
  const stalled = deliveries.observations.filter((delivery) => {
    const state = delivery.value.delivery_state;
    if (state !== "pending" && state !== "retry_wait" && state !== "delivering") return false;
    const due = scheduled(delivery);
    return typeof due === "number" && now - due > GRACE_MS;
  });
  if (stalled.length === 0) return { status: "pass" };

  const boots = markers.kind === "present" ? markers.observations.map((marker) => marker.value.api_start).filter((at) => typeof at === "number") : [];
  const cycleFailures = cycles.kind === "present" ? cycles.observations : [];
  /** @param {number} due */
  const restartExplains = (due) => boots.some((boot) => boot > due - GRACE_MS && now - boot <= RESTART_CAUGHT_UP_MS);
  const unexplained = stalled.filter((delivery) => !restartExplains(scheduled(delivery)));
  const firstDue = Math.min(...stalled.map((delivery) => scheduled(delivery) ?? now));
  const base = {
    window: { from_ms: firstDue, to_ms: now },
    hop: "postgres_claim",
    module: "dispatcher.claim",
    upstream: /** @type {const} */ ("witnessed"),
    facts: stalled.slice(0, 5).map((delivery) => ({
      text: `delivery ${delivery.value.webhook_delivery_id} has been ${delivery.value.delivery_state} since ${new Date(scheduled(delivery) ?? 0).toISOString()}`,
      evidence: [delivery.id, ...cycleFailures.filter((cycle) => cycle.value.webhook_delivery_id === delivery.value.webhook_delivery_id).map((cycle) => cycle.id)],
      window: delivery.window,
      absent: null,
    })),
    falsify: { absence: "an attempt or a terminal state for each stalled delivery after its scheduled time", attribution: null },
  };
  if (unexplained.length === 0) {
    return {
      ...base,
      status: "finding",
      outcome: "expected",
      reason: "webhook.deploy_restart",
      observed: `${stalled.length} delivery(ies) waited while the API restarted and is catching up`,
      hypothesis: { text: "the dispatcher restart paused claims and it is working through the backlog", falsified_by: "deliveries still stalled after the catch-up window" },
    };
  }
  return {
    ...base,
    status: "finding",
    outcome: "degraded",
    reason: null,
    observed: `${unexplained.length} delivery(ies) sat ${unexplained[0].value.delivery_state} past their next attempt time`,
    hypothesis: { text: "the claim path is blocked — for example a held advisory lock or a dispatcher that stopped claiming", falsified_by: "a claim or attempt for each stalled delivery after its scheduled time" },
  };
}
