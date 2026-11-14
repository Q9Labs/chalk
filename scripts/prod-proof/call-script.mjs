// The scripted three-guest call that call-artifacts plays, and the checks that find that script again in the Recording.
// Every expectation (marker times, silence bound, mute and stop windows) derives from the one `script` object that the run records.

export const slotSeconds = 8;
export const guestCount = 3;
export const cycleSeconds = slotSeconds * guestCount;
export const markerSeconds = 0.5;
export const phraseDelaySeconds = 1;
export const flashSeconds = 0.4;
// One pure tone per guest. A guest's marker, and the hold tone that the mute and stop checks use, share its frequency.
export const markerHz = [1500, 2000, 2500];
export const hopSeconds = 0.05;
export const frameRate = 20;

export const bounds = {
  // Largest difference between the loop start that a guest's page reports and the shared start it was asked for.
  loopSkewMs: 150,
  // Marker tones must appear this close to the time the script gives, once anchored on guest 1's first marker.
  markerOffsetMs: 1500,
  // Largest gap between a guest's flash and its beep in the Recording.
  avOffsetMs: 300,
  // A mute, an unshare or a host stop the node hears takes effect at once, so captured media may outlive it by 15 s at most. Only a stop the node never heard of waits for the source lease (60 s by default, docs/plans/sfu-design.md "Reconnect and authority"), and this script never cuts the control path.
  endMs: 15_000,
  // Silence beyond the script's own longest gap (hold tones and the next marker start on different clocks).
  silenceToleranceMs: 2500,
  // Tone detection: share of a hop's energy at the tone frequency, and the level below which a hop is silent.
  toneRatio: 0.15,
  silenceDb: -50,
  // A hold tone must be heard for at least this long before its stop.
  heldToneSeconds: 4,
  // The shared screen is the proof browser's fake display (see screenGreenPixel in recording-evidence.mjs), which fills most of the primary tile. A camera's coloured squares cover about 1% of a frame, so this share only holds while the screen is shown.
  screenGreenShare: 0.2,
};

/** Wall-clock times (ms) of one guest's markers in one round. */
export function markerTimes(round, guest) {
  const start = round.guests.find((entry) => entry.guest === guest)?.startMs;
  if (start === undefined) return [];
  return Array.from({ length: round.cycles }, (_, cycle) => start + (guest * slotSeconds + cycle * cycleSeconds) * 1000);
}

/** Every sound the script plays, as wall-clock intervals in ms. */
export function expectedSounds(script) {
  const sounds = [];
  for (const round of script.rounds) {
    for (const { guest } of round.guests) {
      for (const marker of markerTimes(round, guest)) {
        sounds.push([marker, marker + markerSeconds * 1000]);
        sounds.push([marker + phraseDelaySeconds * 1000, marker + (phraseDelaySeconds + script.phraseSeconds[guest]) * 1000]);
      }
    }
  }
  sounds.push([script.hold.startMs, script.hold.muteMs], [script.screen.startMs, script.screen.stopMs], [script.stop.holdStartMs, script.stop.stopMs]);
  return sounds.sort((a, b) => a[0] - b[0]);
}

/** The longest silence the script itself contains between its first sound and the host stop, skipping the restart window. */
export function longestScriptedSilenceMs(script) {
  let longest = 0;
  let reach = -Infinity;
  for (const [start, end] of expectedSounds(script)) {
    const excused = script.restart && start > script.restart.startMs && start <= script.restart.roundStartMs;
    if (reach > -Infinity && !excused) longest = Math.max(longest, start - reach);
    reach = Math.max(reach, end);
  }
  return longest;
}

export function silenceBoundMs(script) {
  return longestScriptedSilenceMs(script) + bounds.silenceToleranceMs;
}

// ---- Signal analysis ----

/** Share of the window's energy at one frequency (1 for a pure tone, near 0 for speech), with the window's mean power. */
function tonality(samples, start, length, hz, rate) {
  const coefficient = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let previous = 0;
  let before = 0;
  let energy = 0;
  for (let index = start; index < start + length; index++) {
    const value = samples[index];
    const next = value + coefficient * previous - before;
    before = previous;
    previous = next;
    energy += value * value;
  }
  const power = previous * previous + before * before - coefficient * previous * before;
  return { ratio: energy === 0 ? 0 : power / ((length / 2) * energy), meanSquare: energy / length };
}

function intervalsOf(flags, hop, mergeGapSeconds) {
  const intervals = [];
  for (let index = 0; index < flags.length; index++) {
    if (!flags[index]) continue;
    const start = index * hop;
    const last = intervals.at(-1);
    if (last && start - last.end <= mergeGapSeconds + 1e-9) last.end = start + hop;
    else intervals.push({ start, end: start + hop });
  }
  return intervals;
}

/** Per-hop level in dBFS, silent intervals, and the intervals where each frequency is a clear tone. */
export function analyzeAudio(samples, rate, frequencies) {
  const length = Math.round(rate * hopSeconds);
  const hops = Math.floor(samples.length / length);
  const levelsDb = new Float32Array(hops);
  const tonalFlags = frequencies.map(() => Array.from({ length: hops }, () => false));
  for (let hop = 0; hop < hops; hop++) {
    let energy = 0;
    for (let index = hop * length; index < (hop + 1) * length; index++) energy += samples[index] * samples[index];
    levelsDb[hop] = 10 * Math.log10(energy / length + 1e-12);
    if (levelsDb[hop] < -60) continue;
    frequencies.forEach((hz, position) => {
      tonalFlags[position][hop] = tonality(samples, hop * length, length, hz, rate).ratio >= bounds.toneRatio;
    });
  }
  const silent = Array.from(levelsDb, (level) => level < bounds.silenceDb);
  return {
    levelsDb,
    silences: intervalsOf(silent, hopSeconds, 0).filter((interval) => interval.end - interval.start >= 0.5),
    tones: Object.fromEntries(frequencies.map((hz, position) => [hz, intervalsOf(tonalFlags[position], hopSeconds, 0.3).filter((interval) => interval.end - interval.start >= 0.2)])),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Start times (s) of the bright flashes: runs of frames far above the median brightness around them. */
export function findFlashes(lumas, fps = frameRate, threshold = 8) {
  const radius = 2 * fps;
  const onsets = [];
  let inFlash = false;
  for (let index = 0; index < lumas.length; index++) {
    const baseline = median(lumas.slice(Math.max(0, index - radius), index + radius + 1));
    const bright = lumas[index] - baseline > threshold;
    if (bright && !inFlash) onsets.push(index / fps);
    inFlash = bright;
  }
  return onsets;
}

// ---- Judging the Recording against the script ----

const seconds = (ms) => ms / 1000;
const near = (value, target, toleranceSeconds) => Math.abs(value - target) <= toleranceSeconds;

function excused(script, wallMs) {
  return Boolean(script.restart) && wallMs >= script.restart.startMs && wallMs < script.restart.roundStartMs;
}

/** The markers a guest is expected to sound, leaving out those inside the capture-node restart window. */
export function scriptedMarkers(script, guest) {
  return script.rounds.flatMap((round, roundIndex) =>
    markerTimes(round, guest)
      .map((wallMs, cycle) => ({ wallMs, round: roundIndex + 1, cycle: cycle + 1 }))
      .filter(({ wallMs }) => !excused(script, wallMs)),
  );
}

export const heardAt = (signals, guest, recordingSeconds) => signals.tones[markerHz[guest]].some((interval) => near(interval.start, recordingSeconds, seconds(bounds.markerOffsetMs)));

/**
 * Maps wall-clock ms to a Recording's seconds (rec) and back (wall). The origin of a Recording or track is not known, so its first tone of
 * the guest is taken for whichever scripted marker makes the most markers line up; a lost first marker cannot shift every later one.
 */
export function alignClock(script, signals, guest) {
  const first = signals.tones[markerHz[guest]]?.[0];
  if (!first) return null;
  const markers = scriptedMarkers(script, guest);
  let best = null;
  for (const { wallMs: anchorWall } of markers) {
    const clock = { rec: (wallMs) => first.start + seconds(wallMs - anchorWall), wall: (recordingSeconds) => anchorWall + (recordingSeconds - first.start) * 1000 };
    const matched = markers.filter((marker) => heardAt(signals, guest, clock.rec(marker.wallMs))).length;
    if (!best || matched > best.matched) best = { clock, matched };
  }
  return best?.clock ?? null;
}

function markerChecks(script, signals, clock) {
  const checks = [];
  script.rounds.forEach((round, roundIndex) => {
    for (const { guest } of round.guests) {
      markerTimes(round, guest).forEach((wallMs, cycle) => {
        if (excused(script, wallMs)) return;
        const expected = clock(wallMs);
        const found = signals.tones[markerHz[guest]].find((interval) => near(interval.start, expected, seconds(bounds.markerOffsetMs)));
        const flash = found && signals.flashes.find((onset) => near(onset, found.start, 1.5));
        checks.push({ guest: guest + 1, round: roundIndex + 1, cycle: cycle + 1, wallMs, expected, tone: found?.start ?? null, flash: flash ?? null, avOffsetMs: found && flash !== undefined ? Math.round((flash - found.start) * 1000) : null });
      });
    }
  });
  return checks;
}

function phraseHeard(script, signals, markerStart, guest) {
  const from = Math.round((markerStart + phraseDelaySeconds + 0.3) / hopSeconds);
  const to = Math.round((markerStart + phraseDelaySeconds + script.phraseSeconds[guest] - 0.3) / hopSeconds);
  const window = Array.from(signals.levelsDb.slice(Math.max(0, from), Math.max(0, to)));
  return window.length > 0 && window.filter((level) => level > bounds.silenceDb).length >= window.length * 0.4;
}

function heldTone(signals, clock, hz, startMs, endMs) {
  const from = clock(startMs);
  const to = clock(endMs);
  const intervals = signals.tones[hz].filter((interval) => interval.end > from);
  const heard = intervals.reduce((total, interval) => total + Math.max(0, Math.min(interval.end, to) - Math.max(interval.start, from)), 0);
  const lastEnd = intervals.at(-1)?.end ?? null;
  return { heardSeconds: heard, endedAfterMs: lastEnd === null ? null : Math.round((lastEnd - to) * 1000) };
}

/** Everything measured from the Recording against the script, and the failures. */
export function judgeScript(script, signals, durationSeconds) {
  const failures = [];
  const clock = alignClock(script, signals, script.anchorGuest)?.rec;
  if (!clock) return { failures: [`Recording has no marker tone for guest ${script.anchorGuest + 1}, so nothing in it can be timed`], measurements: {} };

  const markers = markerChecks(script, signals, clock);
  for (const marker of markers) {
    const label = `guest ${marker.guest}'s marker ${marker.cycle} of round ${marker.round}`;
    if (marker.tone === null) failures.push(`Recording has no ${label} at the expected time (${marker.expected.toFixed(1)}s, ±${bounds.markerOffsetMs} ms)`);
    else if (marker.flash === null) failures.push(`Recording has no camera flash for ${label}`);
    else if (Math.abs(marker.avOffsetMs) > bounds.avOffsetMs) failures.push(`Recording's ${label} has its flash ${marker.avOffsetMs} ms from its beep, beyond ${bounds.avOffsetMs} ms`);
    else if (!phraseHeard(script, signals, marker.tone, marker.guest - 1)) failures.push(`Recording has no speech after ${label}`);
  }

  const bound = silenceBoundMs(script);
  const domainEnd = clock(script.stop.stopMs + bounds.endMs);
  const silences = signals.silences.filter((interval) => interval.start >= clock(expectedSounds(script)[0][0]) && interval.start < domainEnd && !(script.restart && interval.end > clock(script.restart.startMs) && interval.start < clock(script.restart.roundStartMs)));
  const longest = Math.max(0, ...silences.map((interval) => (Math.min(interval.end, domainEnd) - interval.start) * 1000));
  if (longest > bound) failures.push(`Recording has a ${Math.round(longest)} ms silence, longer than the ${Math.round(bound)} ms the script allows`);

  const holds = [
    { name: "guest 2's tone", hz: markerHz[script.hold.guest], startMs: script.hold.startMs, endMs: script.hold.muteMs, action: "mute" },
    { name: `guest ${script.stop.guest + 1}'s tone`, hz: markerHz[script.stop.guest], startMs: script.stop.holdStartMs, endMs: script.stop.stopMs, action: "host stop" },
  ].map((hold) => ({ ...hold, ...heldTone(signals, clock, hold.hz, hold.startMs, hold.endMs) }));
  for (const hold of holds) {
    const needed = Math.min(bounds.heldToneSeconds, seconds(hold.endMs - hold.startMs) / 2);
    if (hold.heardSeconds < needed) failures.push(`Recording carries ${hold.name} for only ${hold.heardSeconds.toFixed(1)}s before the ${hold.action}`);
    else if (hold.endedAfterMs > bounds.endMs) failures.push(`Recording still carries ${hold.name} ${hold.endedAfterMs} ms after the ${hold.action}, beyond ${bounds.endMs} ms`);
  }

  const shared = signals.green.filter((frame) => frame.time >= clock(script.screen.startMs) + bounds.heldToneSeconds && frame.time <= clock(script.screen.stopMs));
  const sharedShare = shared.length ? shared.filter((frame) => frame.share >= bounds.screenGreenShare).length / shared.length : 0;
  if (sharedShare < 0.5) failures.push(`Recording shows the shared screen in only ${Math.round(sharedShare * 100)}% of the sampled frames while shared`);
  const after = signals.green.filter((frame) => frame.time >= clock(script.screen.stopMs) + seconds(bounds.endMs) && frame.time <= durationSeconds);
  const lingering = after.filter((frame) => frame.share >= bounds.screenGreenShare).length;
  if (after.length && lingering / after.length > 0.2) failures.push("Recording still shows the shared screen after it was stopped");

  const runOnMs = (durationSeconds - clock(script.stop.stopMs)) * 1000;
  if (runOnMs > bounds.endMs) failures.push(`Recording runs ${Math.round(runOnMs)} ms past the host stop, beyond ${bounds.endMs} ms`);

  if (script.restart && !script.restart.resumed) failures.push("Capture did not resume after the capture-node restart");
  return { failures, measurements: { markers, holds, runOnMs: Math.round(runOnMs), silenceBoundMs: Math.round(bound), longestSilenceMs: Math.round(longest) } };
}
