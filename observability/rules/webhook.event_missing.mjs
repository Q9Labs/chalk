// @ts-check
/**
 * webhook.event_missing: a lifecycle transition an endpoint subscribed to (episode.started, participant.joined,
 * participant.left) or one the API commits unconditionally (episode.ended) has no webhook_events row. endpoint.test events are
 * not transitions and never count. A transition younger than the settle window may still be in flight, so it is skipped; an
 * unsubscribed transition expects nothing and passes.
 *
 * The witnesses are in areas/webhooks.json: `webhook.transition` from Postgres, `webhook.event` from Postgres and
 * `webhook.endpoint` from Postgres. Endpoint rows are revisions: each is the state of one endpoint from its `occurred_at_ms`
 * until its `deleted_at_ms`, so the subscription a transition saw is the revision covering its time.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "webhook.event_missing";

/** A committed row is authoritative well before this; a transition younger than it is still in flight. */
const SETTLE_MS = 30_000;

export const expected = "every lifecycle transition a subscribed endpoint should hear has a committed webhook_events row";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "tenant";

/** @param {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} endpoint @param {string} eventName @param {number} at */
const covers = (endpoint, eventName, at) => {
  const from = endpoint.value.occurred_at_ms;
  const to = endpoint.value.deleted_at_ms;
  if (typeof from === "number" && from > at) return false;
  if (typeof to === "number" && to <= at) return false;
  if (endpoint.value.enabled !== true || endpoint.value.current === false) return false;
  const subscribed = typeof endpoint.value.subscribed === "string" ? endpoint.value.subscribed.split(",") : [];
  return subscribed.includes(eventName);
};

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const transitions = readings["webhook.transition"];
  const events = readings["webhook.event"];
  const endpoints = readings["webhook.endpoint"];
  if (transitions.kind === "unknown") return { status: "unknown", reason: "the tenant's lifecycle transitions are not fully read" };
  if (transitions.kind === "absent") return { status: "pass" };
  if (endpoints.kind === "unknown") return { status: "unknown", reason: "which endpoints were subscribed when is not fully read" };
  if (events.kind === "unknown") return { status: "unknown", reason: "the committed webhook events are not fully read" };
  const rows = events.kind === "present" ? events.observations : [];
  const revisions = endpoints.kind === "present" ? endpoints.observations : [];
  const now = window.to_ms;

  /** @type {{ transition: import("../../scripts/diagnose-call/proof/evidence.mjs").Observation, endpoint: import("../../scripts/diagnose-call/proof/evidence.mjs").Observation | null }[]} */
  const missing = [];
  for (const transition of transitions.observations) {
    const name = transition.value.event_name;
    const at = transition.value.occurred_at_ms;
    if (typeof name !== "string" || typeof at !== "number") continue;
    if (now !== null && now - at < SETTLE_MS) continue;
    if (rows.some((row) => row.value.event_name === name && row.value.resource_id === transition.value.resource_id)) continue;
    const subscriber = revisions.find((revision) => covers(revision, name, at)) ?? null;
    if (name === "episode.ended") missing.push({ transition, endpoint: subscriber });
    else if (subscriber !== null) missing.push({ transition, endpoint: subscriber });
  }
  if (missing.length === 0) return { status: "pass" };
  const first = missing[0];
  const names = [...new Set(missing.map(({ transition }) => transition.value.event_name))].join(", ");
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(...missing.map(({ transition }) => transition.value.occurred_at_ms)), to_ms: now },
    hop: "postgres_emit",
    module: "postgres.outbox",
    reason: null,
    upstream: "witnessed",
    observed: `${missing.length} transition(s) (${names}) never became a webhook event${first.endpoint ? ` though endpoint ${first.endpoint.value.webhook_endpoint_id} subscribed` : ""}`,
    facts: missing.slice(0, 5).map(({ transition, endpoint }) => ({
      text: `${transition.value.event_name} on ${transition.value.resource_id} has no webhook event${endpoint ? ` (endpoint ${endpoint.value.webhook_endpoint_id} subscribed)` : " (episode.ended is committed unconditionally)"}`,
      evidence: [transition.id, ...(endpoint ? [endpoint.id] : [])],
      window: transition.window,
      absent: "webhook.event",
    })),
    hypothesis: { text: "the outbox trigger or the producer dropped the transition between commit and the webhook_events insert", falsified_by: "a webhook_events row for each transition's event name and resource" },
    falsify: { absence: "a webhook_events row matching the transition's event name and resource id", attribution: null },
  };
}
