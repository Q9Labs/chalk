// The long-call proof schedule is shared by the runner and its contract tests.
// apps/api/internal/accessgrants/types.go Lifetime and sdks/typescript/client/src/access/manager.ts DEFAULT_REFRESH_WINDOW_MS.
// long-call-criteria.test.mjs checks both source values against this proof.
export const accessLifetimeMs = 5 * 60_000;
export const refreshWindowMs = 60_000;
/** A grant is renewed this long after it was issued. */
export const refreshIntervalMs = accessLifetimeMs - refreshWindowMs;
const minimumDurationMs = 10 * 60_000;
/** Two full lifetimes, so the call outlives every first-generation credential, and never under ten minutes. */
export const callDurationMs = Math.max(minimumDurationMs, 2 * accessLifetimeMs);

export const bounds = {
  /** Outbound audio may stand still this long while the guest's microphone shows on. */
  outboundStallMs: 8000,
  /** A remote tile may stand still this long while its sender is on. */
  inboundStallMs: 10_000,
  /** No connected peer connection, or a status other than live, may last this long. */
  disconnectedMs: 10_000,
  /** A toggle counts as testing a refresh when it falls this close to the refresh request. */
  acrossRefreshMs: 10_000,
  /** A grant's successor must be requested within this long after the grant's refresh point (its expiry less the refresh window). */
  refreshLateMs: 30_000,
  sampleIntervalMs: 2000,
  /** Per-guest signaling request target; the gate is derived from the node cap for three guests and remains 176 KiB for larger calls. */
  signalTargetBytes: 48 * 1024,
};

const baselineToggleMs = [60_000, 120_000, 180_000, 330_000, 390_000, 540_000];

/**
 * Guest 1 mutes its microphone and unmutes it, and guest 2 (the second to join, so the one that pulled guest 1's microphone first) does the same right after.
 * Guest 2 must keep its peer connection through guest 1's mute and through its own, and that is early enough to fail the call before the long hold.
 */
const muteRelay = [...offOn(20_000, 0, "microphone"), ...offOn(30_000, 1, "microphone")];

/** The baseline toggles, which do not depend on when a refresh happens. */
export function baselineToggles() {
  return [...muteRelay, ...baselineToggleMs.flatMap((atMs, index) => offOn(atMs, index % 2, index % 4 < 2 ? "microphone" : "camera"))];
}

function offOn(atMs, guest, kind) {
  return [
    { atMs, guest, kind, enabled: false },
    { atMs: atMs + 6000, guest, kind, enabled: true },
  ];
}

/**
 * The guest toggles its microphone before and camera after one access refresh due at `dueMs`,
 * so a refresh within 2 s of `dueMs` has a toggle on either side within the bound.
 */
export function refreshToggles(dueMs, guest = 0) {
  return [...offOn(dueMs - 8000, guest, "microphone"), ...offOn(dueMs + 2000, guest, "camera")];
}

/**
 * The toggle groups to add at `nowMs`. `dues` lists each guest's pending refresh as `{ key, dueMs }`, where `key` changes whenever the guest gets a new grant;
 * `planned` remembers the keys already planned. Every refresh gets its own group, because refreshes of different guests can be a few seconds apart and one
 * group covers only the 2 s around its due time. A refresh with less than 9 s left, or whose group would run past the end of the call, gets none.
 */
export function planRefreshToggles({ dues, nowMs, planned, durationMs = callDurationMs }) {
  const toggles = [];
  for (const { key, guest = 0, dueMs } of dues) {
    if (planned.has(key) || dueMs <= nowMs + 9000 || dueMs + 10_000 >= durationMs) continue;
    planned.add(key);
    toggles.push(...refreshToggles(dueMs, guest));
  }
  return toggles;
}

/**
 * The toggles of one call if every guest renews its grant at the predicted time, as `{ atMs, guest, kind, enabled }` sorted by time from the
 * start of the call. Every guest toggles around each scheduled refresh. A real call plans the refresh toggles from each guest's current grant instead
 * (long-call.mjs), because a media-connection replacement issues a new grant and moves that guest's next refresh.
 */
export function toggleSchedule({ durationMs = callDurationMs, firstRefreshMs = refreshIntervalMs, guestCount = 3 } = {}) {
  const toggles = baselineToggles();
  for (let boundary = firstRefreshMs; boundary + 10_000 < durationMs; boundary += refreshIntervalMs) {
    for (let guest = 0; guest < guestCount; guest++) toggles.push(...refreshToggles(boundary, guest));
  }
  return toggles.filter((toggle) => toggle.atMs + 1000 < durationMs).sort((a, b) => a.atMs - b.atMs);
}
