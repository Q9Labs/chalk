// @ts-check
/**
 * flags.unrecorded_change: a boot carries a flags_hash different from the same
 * service's previous boot and no release marker for its component covers it —
 * production config changed behind the deploy machinery's back. The deploy
 * lead and slack come from the host-change alert constants.
 */
import { cite, DEPLOY_LEAD_MS, DEPLOY_SLACK_MS, num, present, str } from "./platform-lib.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "flags.unrecorded_change";
export const expected = "every flags_hash a service boots with was already the previous boot's, or a release marker explains the change";
/** A day without a boot changes nothing, and a boot day without a marker is the thing itself, not a reason to stay blind. */
export const healthy_absent = ["flags.snapshot", "flags.boot", "release.marker"];

/** @param {unknown} declaration @param {unknown} seat */
export const applies = (declaration, seat) => declaration?.kind === "platform";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const snapshots = (present(readings["flags.snapshot"]) ?? []).filter((o) => o.source === "api").sort((a, b) => a.window.from_ms - b.window.from_ms);
  const boots = (present(readings["flags.boot"]) ?? []).sort((a, b) => a.window.from_ms - b.window.from_ms);
  const markers = (present(readings["release.marker"]) ?? []).filter((o) => o.source === "release");

  // Pair each boot with its snapshot by source_id: a boot without one cannot
  // be checked, and one boot total has nothing to be checked against.
  const bySource = new Map();
  for (const o of snapshots) {
    const key = str(o, "source_id") || `${o.subject.space ?? ""}|${o.window.from_ms}`;
    bySource.set(key, o);
  }
  const paired = [];
  for (const boot of boots) {
    const snapshot = bySource.get(str(boot, "source_id"));
    if (!snapshot) return { status: "unknown", reason: "boot without a flags snapshot" };
    paired.push({ boot, snapshot });
  }
  if (paired.length === 0) return { status: "pass" };
  if (paired.length === 1) return { status: "unknown", reason: "no previous boot in 30 days" };

  for (let i = 1; i < paired.length; i++) {
    const { boot, snapshot } = paired[i];
    const before = paired[i - 1];
    const hash = str(snapshot, "flags_hash");
    if (!hash || hash === str(before.snapshot, "flags_hash")) continue;
    const covered = markers.some(
      (m) => num(m, "started_ms") >= boot.window.from_ms - DEPLOY_LEAD_MS && num(m, "started_ms") <= boot.window.from_ms + DEPLOY_SLACK_MS,
    );
    if (covered) continue;
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: boot.window.from_ms, to_ms: boot.window.to_ms },
      hop: "config_boot",
      module: "api.config",
      reason: null,
      upstream: "witnessed",
      observed: `a boot came up with flags_hash ${hash.slice(0, 12)} after the previous boot's ${str(before.snapshot, "flags_hash").slice(0, 12)}, and no marker covers it`,
      facts: [
        cite(`the boot's snapshot carries flags_hash ${hash.slice(0, 12)}`, [snapshot, boot]),
        cite(`the previous boot carried ${str(before.snapshot, "flags_hash").slice(0, 12)}`, [before.snapshot, before.boot]),
      ],
      hypothesis: { text: "production config changed without a deploy marker: an env edit or a secret rotation behind the pipeline's back", falsified_by: "a marker with started_at inside [boot - 30 min, boot + 120 s]" },
      falsify: { absence: null, attribution: "a release marker inside the deploy lead and slack" },
    };
  }
  return { status: "pass" };
}
