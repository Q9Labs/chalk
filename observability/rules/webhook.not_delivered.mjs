// @ts-check
/**
 * webhook.not_delivered: a delivery ran out of attempts and went exhausted without a 2xx, so the endpoint never got the event.
 * The hop is where delivery stopped: the receiver when attempts reached it and were refused, the dispatch path when the delivery
 * never got an attempt. Deliveries cancelled by an endpoint deletion or secret rotation are a lifecycle action, not a delivery
 * failure, so they are not flagged here.
 *
 * The witnesses are in areas/webhooks.json: `webhook.delivery` and `webhook.attempt` from Postgres; the optional
 * `webhook.secret_rotation` explains away a cancelled delivery.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "webhook.not_delivered";

export const expected = "every committed delivery reaches a terminal success, or its exhaustion is a finding";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "tenant";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const deliveries = readings["webhook.delivery"];
  const attempts = readings["webhook.attempt"];
  if (deliveries.kind === "unknown") return { status: "unknown", reason: "the tenant's deliveries are not fully read" };
  if (deliveries.kind === "absent") return { status: "pass" };
  if (attempts.kind === "unknown") return { status: "unknown", reason: "the delivery attempts are not fully read" };
  const rows = attempts.kind === "present" ? attempts.observations : [];
  const exhausted = deliveries.observations.filter((delivery) => delivery.value.delivery_state === "exhausted" || delivery.value.delivery_state === "failed");
  if (exhausted.length === 0) return { status: "pass" };
  const first = exhausted[0];
  const firstAttempts = rows.filter((attempt) => attempt.value.webhook_delivery_id === first.value.webhook_delivery_id).sort((a, b) => (a.value.attempt_number ?? 0) - (b.value.attempt_number ?? 0));
  const last = firstAttempts[firstAttempts.length - 1];
  const reachedReceiver = last !== undefined && (typeof last.value.http_status === "number" || (typeof last.value.error_code === "string" && last.value.error_code.startsWith("http")));
  const hop = reachedReceiver ? "receiver" : "api_dispatch";
  const module = reachedReceiver ? "tenant.receiver" : "dispatcher.deliver";
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(...exhausted.map((delivery) => delivery.value.occurred_at_ms ?? window.from_ms)), to_ms: window.to_ms },
    hop,
    module,
    reason: null,
    upstream: reachedReceiver ? "witnessed" : "unknown",
    observed: `${exhausted.length} delivery(ies) exhausted${last ? `; the last attempt on ${first.value.webhook_delivery_id} ended ${last.value.error_code ?? last.value.http_status ?? "unrecorded"}` : " with no attempt ever recorded"}`,
    facts: exhausted.slice(0, 5).map((delivery) => ({
      text: `delivery ${delivery.value.webhook_delivery_id} to endpoint ${delivery.value.webhook_endpoint_id} exhausted after ${delivery.value.attempt_count ?? "?"} attempt(s)`,
      evidence: [delivery.id, ...rows.filter((attempt) => attempt.value.webhook_delivery_id === delivery.value.webhook_delivery_id).map((attempt) => attempt.id)],
      window: delivery.window,
      absent: null,
    })),
    hypothesis: reachedReceiver ? { text: "the receiver refused every attempt, so the retry budget ran out", falsified_by: "a 2xx answer on any attempt" } : { text: "the dispatcher never attempted the delivery before it exhausted", falsified_by: "a delivery_attempts row for the delivery" },
    falsify: { absence: "a succeeded attempt or a 2xx status for the delivery", attribution: null },
  };
}
