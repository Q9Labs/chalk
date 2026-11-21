// @ts-check
/**
 * integration.episode_create_refused: a createSpace or createEpisode request was refused and the resource never appeared. A
 * refusal the live-Episode limit explains is expected — the API did its job; a refusal the Tenant retried into a committed row
 * passes; anything else is broken at the API's create boundary.
 *
 * The witnesses are in areas/webhooks.json: `integration.request` request rows from the API log, `webhook.episode` and
 * `webhook.space` from Postgres and the optional `integration.live_limit` refusal decision.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "integration.episode_create_refused";

const CREATE_ROUTES = ["/episodes", "/spaces"];

export const expected = "every refused createSpace or createEpisode either is the live-Episode limit working or is retried into a committed resource";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "tenant";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const requests = readings["integration.request"];
  const episodes = readings["webhook.episode"];
  const spaces = readings["webhook.space"];
  const limits = readings["integration.live_limit"];
  if (requests.kind === "unknown") return { status: "unknown", reason: "the request log is not fully read" };
  if (requests.kind === "absent") return { status: "pass" };
  if (episodes.kind === "unknown" || spaces.kind === "unknown") return { status: "unknown", reason: "the committed resources are not fully read" };
  const refused = requests.observations.filter((row) => {
    if (typeof row.value.status !== "number" || row.value.status < 400 || row.value.method !== "POST") return false;
    const route = row.value.route;
    return typeof route === "string" && CREATE_ROUTES.some((suffix) => route.endsWith(suffix));
  });
  if (refused.length === 0) return { status: "pass" };
  const episodeRows = episodes.kind === "present" ? episodes.observations : [];
  const spaceRows = spaces.kind === "present" ? spaces.observations : [];
  const limitRefusals = limits.kind === "present" ? limits.observations.filter((row) => row.value.decision === "refused") : [];

  /** @param {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} request */
  const isEpisode = (request) => String(request.value.route).endsWith("/episodes");
  /** @param {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} request */
  const created = (request) => {
    const at = request.window.from_ms;
    const rows = isEpisode(request) ? episodeRows : spaceRows;
    return rows.some((row) => typeof row.value.created_at_ms === "number" && row.value.created_at_ms >= at);
  };
  const expected = refused.filter((request) => isEpisode(request) && limitRefusals.some((limit) => Math.abs(limit.window.from_ms - request.window.from_ms) <= 5_000));
  const recovered = refused.filter((request) => !expected.includes(request) && created(request));
  const broken = refused.filter((request) => !expected.includes(request) && !created(request));
  if (broken.length > 0) {
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: Math.min(...broken.map((request) => request.window.from_ms)), to_ms: window.to_ms },
      hop: "api_create",
      module: "api.episodes",
      reason: null,
      upstream: "witnessed",
      observed: `${broken.length} refused create request(s) never produced a resource${broken[0] ? `; first ${broken[0].value.method} ${broken[0].value.route} → ${broken[0].value.status}` : ""}`,
      facts: broken.slice(0, 5).map((request) => ({
        text: `${request.value.method} ${request.value.route} was refused ${request.value.status} and no ${isEpisode(request) ? "Episode" : "Space"} row exists after it`,
        evidence: [request.id],
        window: request.window,
        absent: isEpisode(request) ? "webhook.episode" : "webhook.space",
      })),
      hypothesis: { text: "the API refused the create for a reason the Tenant could not see or retry past", falsified_by: "a committed resource row after the refusal" },
      falsify: { absence: "a committed Episode or Space row after the refused request", attribution: null },
    };
  }
  if (expected.length > 0) {
    return {
      status: "finding",
      outcome: "expected",
      window: { from_ms: Math.min(...expected.map((request) => request.window.from_ms)), to_ms: window.to_ms },
      hop: "api_create",
      module: "api.episodes",
      reason: "integration.live_episode_limit",
      upstream: "witnessed",
      observed: `${expected.length} create request(s) refused at the live-Episode limit${recovered.length > 0 ? `; ${recovered.length} later succeeded on retry` : ""}`,
      facts: expected.slice(0, 5).map((request) => ({
        text: `${request.value.method} ${request.value.route} refused at the live-Episode limit`,
        evidence: [request.id, ...limitRefusals.filter((limit) => Math.abs(limit.window.from_ms - request.window.from_ms) <= 5_000).map((limit) => limit.id)],
        window: request.window,
        absent: null,
      })),
      hypothesis: null,
      falsify: { absence: null, attribution: null },
    };
  }
  return { status: "pass" };
}
