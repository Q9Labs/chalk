import { alignClock, bounds, expectedSounds, heardAt, hopSeconds, scriptedMarkers, silenceBoundMs } from "./call-script.mjs";

// Where did a missing sound get lost? Each guest's marker is looked for in that guest's own recorder track and in the mix.
//   absent from the guest's own track        -> lost at capture
//   in its own track, absent from the mix    -> lost by the mixer
// A mix silence longer than the script allows is classified by whether any track, or the script itself, has sound there.

function markerVerdicts(script, mix, tracks, mixTime) {
  const verdicts = [];
  for (let guest = 0; guest < tracks.length; guest++) {
    const own = tracks[guest];
    const ownClock = own && alignClock(script, own, guest);
    for (const { wallMs, round, cycle } of scriptedMarkers(script, guest)) {
      const inTrack = Boolean(ownClock) && heardAt(own, guest, ownClock.rec(wallMs));
      const inMix = Boolean(mixTime) && heardAt(mix, guest, mixTime.rec(wallMs));
      const label = `guest ${guest + 1}'s marker ${cycle} of round ${round}`;
      if (!inTrack) verdicts.push({ ok: false, text: `${label}: lost at capture (absent from its own track${inMix ? ", yet present in the mix" : ""})` });
      else if (!inMix) verdicts.push({ ok: false, text: `${label}: lost by the mixer (in its own track, absent from the mix)` });
      else verdicts.push({ ok: true, text: `${label}: in its own track and in the mix` });
    }
  }
  return verdicts;
}

function loudIn(signals, clock, fromWall, toWall) {
  const from = Math.max(0, Math.round(clock.rec(fromWall) / hopSeconds));
  const to = Math.round(clock.rec(toWall) / hopSeconds);
  return Array.from(signals.levelsDb.slice(from, to)).filter((level) => level > bounds.silenceDb).length >= 4;
}

function silenceVerdicts(script, mix, tracks, mixTime) {
  if (!mixTime) return [];
  const bound = silenceBoundMs(script);
  const clocks = tracks.map((track, guest) => (track ? alignClock(script, track, guest) : null));
  const verdicts = [];
  for (const interval of mix.silences) {
    const fromWall = mixTime.wall(interval.start);
    const toWall = mixTime.wall(interval.end);
    const inDomain = fromWall >= expectedSounds(script)[0][0] && toWall <= script.stop.stopMs + bounds.endMs;
    const inRestart = script.restart && toWall > script.restart.startMs && fromWall < script.restart.roundStartMs;
    if (!inDomain || inRestart || toWall - fromWall <= bound) continue;
    const label = `the ${Math.round(toWall - fromWall)} ms silence at ${interval.start.toFixed(1)}s of the mix`;
    const heldByTrack = tracks.findIndex((track, guest) => track && clocks[guest] && loudIn(track, clocks[guest], fromWall, toWall));
    const scripted = expectedSounds(script).some(([start, end]) => start < toWall && end > fromWall);
    if (heldByTrack >= 0) verdicts.push({ ok: false, text: `${label}: lost by the mixer (guest ${heldByTrack + 1}'s track has sound there)` });
    else if (scripted) verdicts.push({ ok: false, text: `${label}: lost at capture (the script has sound there, no track holds it)` });
    else verdicts.push({ ok: false, text: `${label}: a gap in the script itself (no track holds sound there and none was scripted)` });
  }
  return verdicts;
}

/**
 * Verdicts for the mix against the guests' own recorder tracks (one signals object per guest, or null where the recorder output has no track for that guest).
 * Each verdict is { ok, text }; a not-ok verdict names where the sound was lost.
 */
export function trackVerdicts(script, mix, tracks) {
  const mixTime = alignClock(script, mix, script.anchorGuest);
  return [...markerVerdicts(script, mix, tracks, mixTime), ...silenceVerdicts(script, mix, tracks, mixTime)];
}
