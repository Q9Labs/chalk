import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeAudio, bounds, expectedSounds, findFlashes, frameRate, judgeScript, longestScriptedSilenceMs, markerHz, markerTimes, phraseDelaySeconds, screenHz, silenceBoundMs } from "./call-script.mjs";
import { recordingSignals } from "./recording-evidence.mjs";
import { trackVerdicts } from "./track-verdicts.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const rate = 16_000;
const wall = 1_000_000;
const lead = 5; // The Recording starts five seconds before the first marker.
const phraseSeconds = [3, 3.2, 3.4];
const at = (offsetSeconds) => wall + offsetSeconds * 1000;

function baseScript(overrides = {}) {
  return {
    anchorGuest: 0,
    phraseSeconds,
    rounds: [{ guests: [0, 1, 2].map((guest) => ({ guest, startMs: at(0) })), cycles: 2 }],
    hold: { guest: 1, startMs: at(48.5), muteMs: at(60.5) },
    screen: { startMs: at(49), stopMs: at(73) },
    restart: null,
    stop: { guest: 2, holdStartMs: at(74), stopMs: at(84) },
    ...overrides,
  };
}

// Renders the Recording the script should produce, with optional faults, as the signals recordingSignals would find.
function render(script, { drop = () => false, lingerMs = 300, flashLagSeconds = 0.05, shareFrames = true, hole, only, leadSeconds = lead } = {}) {
  const rec = (offsetSeconds) => leadSeconds + offsetSeconds;
  const duration = rec((script.stop.stopMs - wall) / 1000 + 4) + lingerMs / 1000;
  const samples = new Float32Array(Math.ceil(duration * rate));
  let seed = 7;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const tone = (from, to, hz, gain) => {
    for (let index = Math.round(from * rate); index < Math.min(samples.length, Math.round(to * rate)); index++) samples[index] += gain * Math.sin((2 * Math.PI * hz * index) / rate);
  };
  const flashes = [];
  script.rounds.forEach((round, roundIndex) => {
    for (const { guest } of round.guests) {
      if (only !== undefined && guest !== only) continue;
      markerTimes(round, guest).forEach((marker, cycle) => {
        if (drop(guest, roundIndex, cycle)) return;
        const start = rec((marker - wall) / 1000);
        tone(start, start + 0.5, markerHz[guest], 0.3);
        flashes.push(start - flashLagSeconds);
        for (let index = Math.round((start + phraseDelaySeconds) * rate); index < Math.round((start + phraseDelaySeconds + phraseSeconds[guest]) * rate); index++) samples[index] += 0.5 * noise();
      });
    }
  });
  const lag = lingerMs / 1000;
  const held = (from, to, hz) => tone(rec((from - wall) / 1000), rec((to - wall) / 1000) + lag, hz, 0.2);
  if (only === undefined || only === script.hold.guest) held(script.hold.startMs, script.hold.muteMs, markerHz[script.hold.guest]);
  if (only === undefined) held(script.screen.startMs, script.screen.stopMs, screenHz);
  if (only === undefined || only === script.stop.guest) held(script.stop.holdStartMs, script.stop.stopMs, markerHz[script.stop.guest]);
  if (hole) samples.fill(0, Math.round(rec(hole[0]) * rate), Math.round(rec(hole[1]) * rate));
  const green = Array.from({ length: Math.round(duration * frameRate) }, (_, frame) => {
    const time = frame / frameRate;
    return { time, share: shareFrames && time >= rec((script.screen.startMs - wall) / 1000) && time <= rec((script.screen.stopMs - wall) / 1000) + lag ? 0.01 : 0 };
  });
  return { signals: { ...analyzeAudio(samples, rate, [...markerHz, screenHz]), flashes, green }, duration };
}

const judge = (script, options) => {
  const { signals, duration } = render(script, options);
  return judgeScript(script, signals, duration);
};

test("a Recording that plays the script passes every check", () => {
  const { failures, measurements } = judge(baseScript());
  assert.deepEqual(failures, []);
  assert.equal(measurements.markers.length, 6);
  assert.ok(measurements.markers.every((marker) => Math.abs(marker.avOffsetMs) <= 100));
  assert.ok(measurements.holds.every((hold) => hold.endedAfterMs <= 1000));
});

test("the silence bound comes from the script's own longest gap", () => {
  const script = baseScript();
  const gaps = expectedSounds(script)
    .slice(1)
    .map(
      (sound, index) =>
        sound[0] -
        Math.max(
          ...expectedSounds(script)
            .slice(0, index + 1)
            .map((earlier) => earlier[1]),
        ),
    );
  assert.equal(longestScriptedSilenceMs(script), Math.max(...gaps));
  assert.equal(silenceBoundMs(script), Math.max(...gaps) + bounds.silenceToleranceMs);
  // A 12 s turn slot would leave a gap far above the 9.3 s pause that the 8 Nov recording exceeded; this script's longest gap is the 8 s slot minus a phrase.
  assert.ok(longestScriptedSilenceMs(script) < 5000);
});

test("a guest whose marker is missing fails by name, round and cycle", () => {
  const { failures } = judge(baseScript(), { drop: (guest, round, cycle) => guest === 2 && round === 0 && cycle === 1 });
  assert.ok(failures.some((failure) => /no guest 3's marker 2 of round 1 at the expected time/.test(failure)));
});

test("a flash far from its beep fails the A/V bound, and a missing flash fails too", () => {
  const late = judge(baseScript(), { flashLagSeconds: -0.6 });
  assert.ok(late.failures.some((failure) => /flash 600 ms from its beep/.test(failure)));
  const none = render(baseScript());
  const failures = judgeScript(baseScript(), { ...none.signals, flashes: [] }, none.duration).failures;
  assert.ok(failures.some((failure) => /no camera flash/.test(failure)));
});

test("media that outlives the mute or the host stop beyond the bound fails", () => {
  const mute = judge(baseScript(), { lingerMs: 20_000 });
  assert.ok(mute.failures.some((failure) => /still carries guest 2's tone/.test(failure) || /past the host stop/.test(failure)));
  assert.ok(mute.failures.some((failure) => /still carries guest 3's tone .* after the host stop/.test(failure)));
});

test("a screen that never appears fails", () => {
  assert.ok(judge(baseScript(), { shareFrames: false }).failures.some((failure) => /shared screen in only 0%/.test(failure)));
});

test("a silence longer than the script allows fails", () => {
  assert.ok(judge(baseScript(), { hole: [50, 58] }).failures.some((failure) => /ms silence, longer than/.test(failure)));
});

test("a restart window is excused, and a capture that does not resume fails", () => {
  const restart = { startMs: at(73), roundStartMs: at(113), resumed: true };
  const script = baseScript({
    restart,
    rounds: [
      { guests: [0, 1, 2].map((guest) => ({ guest, startMs: at(0) })), cycles: 2 },
      { guests: [0, 2].map((guest) => ({ guest, startMs: at(113) })), cycles: 1 },
    ],
    stop: { guest: 2, holdStartMs: at(138), stopMs: at(148) },
  });
  const good = render(script);
  assert.deepEqual(judgeScript(script, good.signals, good.duration).failures, []);
  const silent = render(script, { drop: (guest, round) => round === 1 });
  assert.ok(judgeScript(script, silent.signals, silent.duration).failures.some((failure) => /no guest 1's marker 1 of round 2/.test(failure)));
  assert.ok(judgeScript({ ...script, restart: { ...restart, resumed: false } }, good.signals, good.duration).failures.includes("Capture did not resume after the capture-node restart"));
});

test("flashes are runs of frames far brighter than their surroundings", () => {
  const lumas = Array.from({ length: 400 }, (_, frame) => (frame >= 100 && frame < 108 ? 200 : 60 + (frame % 7)));
  assert.deepEqual(findFlashes(lumas, 20), [5]);
  assert.deepEqual(
    findFlashes(
      lumas.map((value) => Math.min(value, 70)),
      20,
    ),
    [],
  );
});

test("recordingSignals finds a beep and a flash in a real MP4", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "call-script-"));
  try {
    const file = join(directory, "marker.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x1b365d:s=320x180:r=30:d=7",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,3,3.5),0.3*sin(2*PI*1500*t),0)':s=48000:d=7",
      "-vf",
      "drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable='between(t,3,3.4)'",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      file,
    ]);
    const signals = await recordingSignals(file);
    assert.equal(signals.tones[1500].length, 1);
    assert.ok(Math.abs(signals.tones[1500][0].start - 3) < 0.15);
    assert.equal(signals.flashes.length, 1);
    assert.ok(Math.abs(signals.flashes[0] - 3) < 0.15);
    assert.equal(signals.tones[2000].length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The mix and each guest's own track, rendered from the script; a fault is dropped from the track, the mix, or both.
function verdictsFor({ lostInTrack = () => false, lostInMix = () => false, hole } = {}) {
  const script = baseScript();
  const mix = render(script, { drop: lostInMix, hole }).signals;
  const tracks = [0, 1, 2].map((guest) => render(script, { only: guest, leadSeconds: 2, drop: (g, round, cycle) => lostInTrack(g, round, cycle) }).signals);
  return trackVerdicts(script, mix, tracks);
}

test("a marker in every track and in the mix passes with no verdict against it", () => {
  const verdicts = verdictsFor();
  assert.ok(verdicts.length >= 6);
  assert.deepEqual(
    verdicts.filter((verdict) => !verdict.ok),
    [],
  );
});

test("a marker missing from its own track is lost at capture, even when the mix has it", () => {
  const verdicts = verdictsFor({ lostInTrack: (guest, round, cycle) => guest === 1 && cycle === 1 });
  assert.deepEqual(
    verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.text),
    ["guest 2's marker 2 of round 1: lost at capture (absent from its own track, yet present in the mix)"],
  );
});

test("a marker in its own track but missing from the mix was lost by the mixer", () => {
  const verdicts = verdictsFor({ lostInMix: (guest, round, cycle) => guest === 2 && cycle === 0 });
  assert.deepEqual(
    verdicts.filter((verdict) => !verdict.ok && /marker/.test(verdict.text)).map((verdict) => verdict.text),
    ["guest 3's marker 1 of round 1: lost by the mixer (in its own track, absent from the mix)"],
  );
});

test("a marker missing from both is lost at capture, and a mix silence that a track holds is lost by the mixer", () => {
  const both = verdictsFor({ lostInTrack: (guest, round, cycle) => guest === 0 && cycle === 1, lostInMix: (guest, round, cycle) => guest === 0 && cycle === 1 });
  assert.ok(both.some((verdict) => /guest 1's marker 2 of round 1: lost at capture/.test(verdict.text)));
  // Guest 3's tracked hold tone runs 74 s to 84 s; blanking the mix there leaves a silence that guest 3's track holds.
  const mixer = verdictsFor({ hole: [75, 83] });
  assert.ok(mixer.some((verdict) => /silence at .* lost by the mixer \(guest 3's track has sound there\)/.test(verdict.text)));
});
