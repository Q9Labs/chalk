/** The longest stretch in which a guest's received bytes for one remote track did not grow, from its samples in time order. */
export function longestGaps(ticks, guest) {
  const last = new Map();
  let worst = { ms: 0, track: null, endedAtMs: null };
  for (const { t, guests } of ticks) {
    for (const remote of guests[guest].remotes) {
      const key = `${remote.participantId}:${remote.source}`;
      const seen = last.get(key);
      if (!seen) {
        last.set(key, { bytes: remote.bytes, grewAt: t });
        continue;
      }
      if (remote.bytes > seen.bytes) {
        const gap = t - seen.grewAt;
        if (remote.source === "microphone" && gap > worst.ms) worst = { ms: gap, track: key, endedAtMs: t };
        last.set(key, { bytes: remote.bytes, grewAt: t });
      }
    }
  }
  const end = ticks.at(-1).t;
  for (const [key, seen] of last) {
    if (key.endsWith(":microphone") && end - seen.grewAt > worst.ms) worst = { ms: end - seen.grewAt, track: key, endedAtMs: end };
  }
  return worst;
}

/** A call survived when every guest stayed in it for the whole hold (status live and reachable in every sample, no error) and every other guest's audio was still arriving in the last five seconds. The messages name guests by position, never by participant ID, because they are printed to workflow logs. */
export function judgeCall(ticks, guestCount) {
  const failures = [];
  const lastSamples = ticks.at(-1).guests;
  const lastWindow = ticks.filter((tick) => tick.t >= ticks.at(-1).t - 5000);
  for (let guest = 0; guest < guestCount; guest++) {
    const label = `guest ${guest + 1}`;
    const lost = ticks.find((tick) => !tick.guests[guest].reachable || tick.guests[guest].status !== "live" || tick.guests[guest].errorCode);
    if (lost) failures.push(`${label} was ${lost.guests[guest].reachable ? lost.guests[guest].status : "unreachable"} ${lost.guests[guest].errorCode ?? ""} at +${Math.round((lost.t - ticks[0].t) / 1000)}s`.replace("  ", " "));
    const mic = (tick) => tick.guests[guest].remotes.filter((remote) => remote.source === "microphone");
    const first = mic(lastWindow[0]);
    const lastMic = mic(lastWindow.at(-1));
    if (lastMic.length < guestCount - 1) failures.push(`${label} hears ${lastMic.length} of ${guestCount - 1} other guests at the end`);
    for (const remote of lastMic) {
      const before = first.find((entry) => entry.participantId === remote.participantId);
      if (!before || remote.bytes <= before.bytes) failures.push(`${label} receives no audio from one of the other guests in the last 5s`);
    }
  }
  return failures;
}
