// @ts-check
/**
 * release.version_skew: a component still runs, or the Chalk web app still
 * boots, a release other than the one its newest deploy or rollback marker
 * expects. Server rows carry the version the process runs as service.version;
 * client boots carry the release_sha of the bundle they loaded. An
 * auto_rollback marker re-points the expectation at the previous deploy, a
 * failed marker leaves it unknown, and tabs that booted before the marker are
 * not counted.
 */
import { cite, num, present, str } from "./platform-lib.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "release.version_skew";
export const expected = "every component serves and reports the release its newest deploy or rollback marker expects";
/** A day with no deploy expects nothing; the marker's absence is the healthy claim. */
export const healthy_absent = ["release.marker"];

const SETTLE_AFTER_MARKER_MS = 15 * 60_000;
const ROWS_APART_MS = 60_000;
const TAB_AFTER_MARKER_MS = 10 * 60_000;
const FAULT_COMPONENTS = new Set(["api", "sync", "web", "recorder"]);

/** @param {unknown} declaration @param {unknown} seat */
export const applies = (declaration, seat) => declaration?.kind === "platform";

/** The release a marker expects: deploy/rollback carry it, auto_rollback points at the previous one. @param {readonly any[]} markers @param {any} marker */
function expectedRelease(markers, marker) {
  const kind = str(marker, "marker_kind");
  if (kind === "deploy" || kind === "rollback") return { release: str(marker, "release_id") };
  if (kind === "auto_rollback") {
    const before = markers
      .filter((m) => str(m, "component") === str(marker, "component") && ["deploy", "rollback"].includes(str(m, "marker_kind")) && num(m, "finished_ms") <= num(marker, "finished_ms"))
      .sort((a, b) => num(b, "finished_ms") - num(a, "finished_ms"))[0];
    return before ? { release: str(before, "release_id") } : { gap: "no earlier marker to roll back to" };
  }
  return { gap: "expected release unknown after a failed marker" };
}

/** The newest marker decides the expected release for a component. @param {readonly any[]} markers */
function expectedFor(markers, component) {
  const newest = markers.filter((m) => str(m, "component") === component).sort((a, b) => num(b, "finished_ms") - num(a, "finished_ms"))[0];
  if (!newest) return null;
  return { marker: newest, ...expectedRelease(markers, newest) };
}

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const markers = (present(readings["release.marker"]) ?? []).filter((o) => o.source === "release");
  const running = present(readings["release.running"]) ?? [];
  const client = readings["release.client"].kind === "present" ? readings["release.client"].observations : [];
  const components = [...new Set(markers.map((o) => str(o, "component")))].sort();
  // No marker expects nothing; when the marker read itself is gapped the kernel fails the pass closed.
  if (components.length === 0) return { status: "pass" };
  for (const component of components) {
    const expected = expectedFor(markers, component);
    if (expected?.gap) return { status: "unknown", reason: expected.gap };
  }

  // Server components: api and sync service.version, from the marker's
  // finished_at plus 15 minutes, at least two rows a minute apart.
  for (const source of ["api", "sync"]) {
    const expected = expectedFor(markers, source);
    if (!expected?.release) continue;
    const since = num(expected.marker, "finished_ms") + SETTLE_AFTER_MARKER_MS;
    const rows = running
      .filter((o) => o.source === source && o.window.from_ms >= since && str(o, "service_version") && str(o, "service_version") !== expected.release)
      .sort((a, b) => a.window.from_ms - b.window.from_ms);
    if (rows.length >= 2 && rows[rows.length - 1].window.from_ms - rows[0].window.from_ms >= ROWS_APART_MS) {
      const component = FAULT_COMPONENTS.has(source) ? source : "host";
      const window = { from_ms: rows[0].window.from_ms, to_ms: rows[rows.length - 1].window.to_ms };
      return {
        status: "finding",
        outcome: "broken",
        window,
        hop: "release_rollout",
        module: `${component}.release`,
        reason: null,
        upstream: "witnessed",
        observed: `${source} kept serving ${str(rows[0], "service_version")} after the marker deployed ${expected.release}`,
        facts: [
          cite(`marker deployed ${expected.release} for ${source}`, [expected.marker]),
          cite(`${rows.length} ${source} rows a minute or more apart still ran ${str(rows[0], "service_version")}`, [rows[0], rows[rows.length - 1]]),
        ],
        hypothesis: { text: `the deploy did not take: an old ${source} release kept claiming work`, falsified_by: `${source} rows after the marker carrying ${expected.release}` },
        falsify: { absence: null, attribution: `${source} service.version rows carrying the marker's release` },
      };
    }
  }

  // The Chalk web app: at least two distinct client sessions from two devices,
  // booted at least 10 minutes after the web marker, on another release_sha.
  const web = expectedFor(markers, "web");
  if (web?.release) {
    if (str(web.marker, "commit") === "unavailable(pages_rollback)") {
      return { status: "unknown", reason: "web commit unknown after a Pages rollback" };
    }
    const commit = str(web.marker, "commit");
    const since = num(web.marker, "finished_ms") + TAB_AFTER_MARKER_MS;
    const rows = client.filter((o) => o.window.from_ms >= since && str(o, "release_sha") && str(o, "release_sha") !== commit);
    const sessions = new Set(rows.map((o) => str(o, "client_session_id") || o.subject.attempt));
    const devices = new Set(rows.map((o) => str(o, "device_id")));
    if (sessions.size >= 2 && devices.size >= 2) {
      const first = rows.sort((a, b) => a.window.from_ms - b.window.from_ms)[0];
      return {
        status: "finding",
        outcome: "broken",
        window: { from_ms: first.window.from_ms, to_ms: first.window.to_ms },
        hop: "release_rollout",
        module: "web.release",
        reason: null,
        upstream: "witnessed",
        observed: `web clients kept booting a bundle other than the deployed ${commit.slice(0, 12)}`,
        facts: [
          cite(`marker deployed web ${commit.slice(0, 12)}`, [web.marker]),
          cite(`${sessions.size} client sessions on ${devices.size} devices still booted ${str(first, "release_sha").slice(0, 12)}`, [first, ...rows.filter((o) => o !== first).slice(0, 1)]),
        ],
        hypothesis: { text: "the Pages deploy did not take for the bundle the tabs load", falsified_by: "client boots carrying the marker's commit as their release_sha" },
        falsify: { absence: null, attribution: "client rows carrying the deployed commit" },
      };
    }
  }
  return { status: "pass" };
}
