// @ts-check
/**
 * boot.app_failed: the beacon ran but the app never showed its first screen, a chunk failed past the one allowed reload, or the
 * page threw during render before the call UI mounted. The clock starts at boot.started when the page was already visible, else
 * at boot.visible; a page never visible passes cases (a) to (d). Case (e), a render failure or the root error page, holds even on
 * a never-visible page. Cases (b), (c) and (e) count only what happened before boot.load_call_ui ended ok.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Window} Window */

export const symptom = "boot.app_failed";

const boot_app_ms = 20_000;
const chunk_followup_ms = 10_000;
const call_ui_ms = 20_000;
/** A root error page pairs with a render_failed this far apart; alone it is still broken, under web.boot. */
const error_page_pair_ms = 5_000;

export const expected = "the beacon's page shows its first screen, reloads at most once for a chunk and boots a new session, and never renders the root error page";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "attempt";

export const healthy_absent = ["boot.pagehide", "boot.chunk_failed", "boot.render_failed", "boot.error_page"];

/** @param {Observation | undefined} o */
const moduleOf = (o) => {
  const route = /** @type {string | undefined} */ (o?.value.route_id);
  if (route?.startsWith("/_space")) return "web.entrance";
  if (route?.startsWith("/dashboard")) return "web.dashboard";
  return "web.boot";
};

/** @param {readonly Observation[]} obs @param {number | null} before */
const before = (obs, end) => (end === null ? obs : obs.filter((o) => o.window.from_ms <= end));

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const reading = (name) => readings[name];
  for (const name of ["boot.started", "boot.visible", "boot.app", "boot.pagehide", "boot.chunk_failed", "boot.load_call_ui", "boot.render_failed", "boot.error_page"]) {
    if (reading(name).kind === "unknown") return { status: "unknown", reason: "client incomplete" };
  }
  const started = reading("boot.started");
  if (started.kind !== "present") return { status: "pass" }; // never ran is boot.never_ran's
  const present = (name) => (reading(name).kind === "present" ? reading(name).observations : []);
  const start = started.observations[0];
  const visibleAt = start.value.visibility === "visible" ? start.window.from_ms : present("boot.visible")[0]?.window.from_ms ?? null;
  const everVisible = start.value.visibility === "visible" || present("boot.visible").length > 0;
  const uiEnd = present("boot.load_call_ui").find((o) => o.claim === "ok")?.window.to_ms ?? null;
  const inScope = (o) => before([o], uiEnd).length > 0;

  // (e) a render failure or the root error page on any route, before an ok call UI load.
  const renders = present("boot.render_failed").filter(inScope);
  const errorPages = present("boot.error_page").filter((o) => o.claim === "shown" && inScope(o));
  if (renders.length > 0 || errorPages.length > 0) {
    const paired = errorPages.find((page) => !renders.some((o) => Math.abs(o.window.from_ms - page.window.from_ms) <= error_page_pair_ms));
    const first = [...renders, ...errorPages].sort((a, b) => a.window.from_ms - b.window.from_ms)[0];
    const at = first.window;
    const facts = [];
    if (renders.length > 0)
      facts.push({ text: `boot.render_failed route_id=${renders[0].value.route_id ?? "unknown"} error_name=${renders[0].claim} error_class=${renders[0].value.error_class ?? "other"}`, evidence: [renders[0].id], window: renders[0].window, absent: null });
    if (errorPages.length > 0) facts.push({ text: "boot.error_page shown", evidence: [errorPages[0].id], window: errorPages[0].window, absent: null });
    const appShown = present("boot.app").find((o) => o.claim === "shown");
    if (appShown) facts.push({ text: "boot.app shown", evidence: [appShown.id], window: appShown.window, absent: null });
    if (uiEnd === null) facts.push({ text: "no boot.load_call_ui", evidence: [], window: at, absent: "boot.load_call_ui" });
    return {
      status: "finding",
      outcome: "broken",
      window: at,
      hop: "client_render",
      module: paired ? "web.boot" : moduleOf(renders[0] ?? errorPages[0]),
      reason: null,
      upstream: "witnessed",
      observed: "the page threw during render before the call UI mounted",
      facts,
      hypothesis: { text: "a script or component threw while rendering the entrance", falsified_by: "no root-caught render error and no shown error page on the attempt" },
      falsify: { absence: "a root-caught render error or a shown error page", attribution: "a render failure after boot.load_call_ui ended ok" },
    };
  }

  // (b) a chunk failure whose one reload was already spent; (c) a reload that never booted a new session.
  const chunks = present("boot.chunk_failed").filter(inScope);
  if (chunks.length > 0) {
    const chunk = chunks[chunks.length - 1];
    if (chunk.claim === "false") {
      return {
        status: "finding",
        outcome: "broken",
        window: chunk.window,
        hop: "client_chunk",
        module: "web.boot",
        reason: null,
        upstream: "unknown",
        observed: "a code chunk failed after the one allowed reload",
        facts: [{ text: "boot.chunk_failed reloaded=false", evidence: [chunk.id], window: chunk.window, absent: null }],
        hypothesis: { text: "the deployment changed under the loaded page and its surviving chunks no longer match", falsified_by: "a new client session on the same device within 10 s" },
        falsify: { absence: "a chunk failure with reloaded=false", attribution: "a chunk failure that reloaded and booted a new session" },
      };
    }
    if (chunk.value.device_ephemeral === true) return { status: "unknown", reason: "the device is ephemeral; its next session can't be linked" };
    const follow = present("boot.started").find(
      (o) => o.value.device_id === chunk.value.device_id && o.value.client_session_id !== start.value.client_session_id && o.window.from_ms >= chunk.window.from_ms && o.window.from_ms <= chunk.window.from_ms + chunk_followup_ms,
    );
    if (!follow) {
      return {
        status: "finding",
        outcome: "broken",
        window: { from_ms: chunk.window.from_ms, to_ms: chunk.window.from_ms + chunk_followup_ms },
        hop: "client_chunk",
        module: "web.boot",
        reason: null,
        upstream: "unknown",
        observed: "a chunk reloaded but no new session booted on the same device",
        facts: [
          { text: "boot.chunk_failed reloaded=true", evidence: [chunk.id], window: chunk.window, absent: null },
          { text: "no new client session on the same device within 10 s", evidence: [], window: { from_ms: chunk.window.from_ms, to_ms: chunk.window.from_ms + chunk_followup_ms }, absent: "boot.started" },
        ],
        hypothesis: { text: "the reload itself failed, such as an offline tab or a second broken chunk", falsified_by: "a boot.started on the same device within 10 s of the reload" },
        falsify: { absence: "a boot.started on the same device within 10 s", attribution: "a new session on another device" },
      };
    }
    return {
      status: "finding",
      outcome: "expected",
      window: chunk.window,
      hop: null,
      module: null,
      reason: "boot.chunk_reloaded",
      upstream: "witnessed",
      observed: "the one allowed chunk-failure reload ran and a new session booted on the same device",
      facts: [
        { text: "boot.chunk_failed reloaded=true", evidence: [chunk.id], window: chunk.window, absent: null },
        { text: `new attempt ${follow.value.client_session_id} on the same device`, evidence: [follow.id], window: follow.window, absent: null },
      ],
      hypothesis: null,
      falsify: { absence: null, attribution: "a new client session on the same device within 10 s" },
    };
  }

  // (d) the call UI load never terminated, or ended error for a reason other than a chunk.
  const loads = present("boot.load_call_ui");
  const badLoad = loads.find((o) => o.claim === "error" && o.value.reason_code !== "boot.chunk_load");
  const openLoad = loads.find((o) => o.window.to_ms === null);
  if (badLoad || (openLoad && window.to_ms !== null && window.to_ms - openLoad.window.from_ms >= call_ui_ms)) {
    const at = (badLoad ?? openLoad).window;
    return {
      status: "finding",
      outcome: "broken",
      window: at,
      hop: "client_call_ui",
      module: "web.boot",
      reason: null,
      upstream: "unknown",
      observed: badLoad ? `the call UI load ended error(${badLoad.value.reason_code ?? "unclassified"})` : "the call UI load never terminated within 20 s",
      facts: [{ text: badLoad ? `boot.load_call_ui ended error(${badLoad.value.reason_code ?? "unclassified"})` : "boot.load_call_ui with no terminal", evidence: [(badLoad ?? openLoad).id], window: at, absent: null }],
      hypothesis: { text: "the call UI's dynamic import or its runtime failed without a chunk signal", falsified_by: "a boot.load_call_ui terminal of ok or error(boot.chunk_load)" },
      falsify: { absence: "a boot.load_call_ui row", attribution: "an error(boot.chunk_load), which the chunk cases judge" },
    };
  }

  // (a) no boot.app shown and the page hid at least 20 s after the clock start still not shown.
  if (!everVisible || visibleAt === null) return { status: "pass" };
  const appShown = present("boot.app").find((o) => o.claim === "shown" && o.window.from_ms <= visibleAt + boot_app_ms);
  if (!appShown) {
    const hides = present("boot.pagehide");
    if (hides.length === 0) return { status: "unknown", reason: "no boot.pagehide; the page may still be open" };
    const hide = hides.find((o) => o.claim === "false" && o.window.from_ms >= visibleAt + boot_app_ms);
    if (hide) {
      const w = { from_ms: visibleAt, to_ms: hide.window.from_ms };
      return {
        status: "finding",
        outcome: "broken",
        window: w,
        hop: "client_boot",
        module: "web.boot",
        reason: null,
        upstream: "unknown",
        observed: "the beacon ran but the app never showed its first screen",
        facts: [
          { text: `no boot.app shown within ${boot_app_ms / 1000} s of the clock start`, evidence: [], window: w, absent: "boot.app" },
          { text: "boot.pagehide app_shown=false", evidence: [hide.id], window: hide.window, absent: null },
        ],
        hypothesis: { text: "the app bundle failed to parse or run after the beacon", falsified_by: "a boot.app surface on the attempt" },
        falsify: { absence: "a boot.app surface", attribution: "a page never visible, or a hide inside 20 s" },
      };
    }
  }
  return { status: "pass" };
}
