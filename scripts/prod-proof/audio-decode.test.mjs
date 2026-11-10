import assert from "node:assert/strict";
import test from "node:test";
import { decodeCriteria, hearAfterUnmute, judgeSilence, judgeSpeech, judgeTone, pairsOf, proveAudioDecoded, proveSilenceFrom, spectrumReading, toneHz, unheardAfterUnmute, unmuteHearMs } from "./audio-decode.mjs";

const sampleRate = 48_000;
const { fftSize } = decodeCriteria;

// A fake AnalyserNode: it windows the samples with Blackman and returns dB per bin like getFloatFrequencyData does.
function fftMagnitudes(re) {
  const n = re.length;
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  return Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]) / n);
}
function fakeAnalyser(samples) {
  const windowed = Float64Array.from(samples, (x, i) => x * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize) + 0.08 * Math.cos((4 * Math.PI * i) / fftSize)));
  return Float32Array.from(fftMagnitudes(windowed), (magnitude) => 20 * Math.log10(magnitude));
}
function noise(seed, amplitude) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return (state / 2 ** 32 - 0.5) * 2 * amplitude;
  };
}
const sine = (hz, amplitude, random = noise(1, 0)) => Float64Array.from({ length: fftSize }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate) + random());
const silent = () => new Float64Array(fftSize);
const read = (samples, hz = 440) => spectrumReading(fakeAnalyser(samples), { hz, sampleRate });
const frames = (count, make) => Array.from({ length: count }, make);

test("the fixture's tone at the published amplitude is read at its bin, far above the floor", () => {
  const reading = read(sine(toneHz(0), 0.15, noise(2, 0.0005)));
  assert.equal(reading.bin, Math.round((440 * fftSize) / sampleRate));
  assert.ok(reading.toneDb > -35 && reading.toneDb < -25, `tone at ${reading.toneDb} dB`);
  assert.ok(reading.marginDb > 50, `margin ${reading.marginDb} dB`);
});

test("tone in: a tone held for a second is heard", () => {
  const verdict = judgeTone(frames(15, () => read(sine(440, 0.15, noise(3, 0.0005)))));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.sustainedFrames, 15);
  assert.equal(verdict.bin, 38);
});

test("bytes advance but the audio is another frequency, silence or noise: the tone is not heard", () => {
  const other = judgeTone(frames(15, () => read(sine(1320, 0.15))));
  const none = judgeTone(frames(15, () => read(silent())));
  const hiss = judgeTone(frames(15, () => read(Float64Array.from({ length: fftSize }, noise(4, 0.3)))));
  for (const verdict of [other, none, hiss]) assert.equal(verdict.pass, false);
  assert.ok(other.peakDb < -60, "the wrong tone adds no energy at the right bins");
});

test("a tone that flickers does not count: the frames must be consecutive", () => {
  const tone = read(sine(440, 0.15));
  const gap = read(silent());
  const readings = frames(20, (_, i) => (i % 6 === 5 ? gap : tone));
  assert.equal(judgeTone(readings).pass, false);
  assert.equal(judgeTone(readings).sustainedFrames, 5);
  assert.equal(judgeTone([...frames(9, () => tone)]).pass, false);
});

test("mute => silence: the newest second at the tone's bins is empty", () => {
  const tone = read(sine(440, 0.15));
  const quiet = read(silent());
  const muted = [...frames(8, () => tone), ...frames(12, () => quiet)];
  const verdict = judgeSilence(muted);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.lastDb, -140);
  assert.equal(judgeSilence([...frames(8, () => tone), ...frames(5, () => quiet)]).pass, false, "the mute has not settled yet");
  assert.equal(judgeSilence(frames(15, () => tone)).pass, false);
  assert.equal(judgeSilence([]).pass, false, "no frames is not silence");
});

test("speech without a tone: broadband energy passes, empty audio does not", () => {
  const voice = read(Float64Array.from({ length: fftSize }, noise(5, 0.2)), null);
  assert.equal(judgeSpeech(frames(12, () => voice)).pass, true);
  assert.equal(judgeSpeech(frames(12, () => read(silent(), null))).pass, false);
});

test("speech from the quiet fixture guest passes: words peak near -54 dB and pauses read lower", () => {
  // Measured on the fixture's voice at guest 2's gain of 0.08 (fixture.mjs): in any 1.5 s window at most 6 frames reach -60 dB and 13 reach -70 dB.
  const reading = (bandDb) => ({ bin: -1, toneDb: null, floorDb: -135, marginDb: null, bandDb });
  const window = [-54, -56, -58, -54, -57, -59, -66, -68, -67, -69, -66, -68, -69, -90, -95].map(reading);
  assert.equal(judgeSpeech(window).pass, true);
  assert.equal(judgeSpeech(window.map(() => reading(-140))).pass, false, "digital silence still fails");
  assert.equal(judgeSpeech(window.map(() => reading(-85))).pass, false, "a faint hiss is not speech");
});

test("every guest hears every other guest", () => {
  assert.deepEqual(
    pairsOf([0, 1, 2]).map(({ listener, speaker }) => `${listener}<${speaker}`),
    ["0<1", "0<2", "1<0", "1<2", "2<0", "2<1"],
  );
});

// A fake call: each page returns the readings its listener would have analysed for each speaker.
const fixedCriteria = { ...decodeCriteria, intervalMs: 1 };
function fakeCall(tones, readingsOf, publishes = true) {
  const participants = ["a", "b"];
  return {
    tones,
    participants,
    pages: [0, 1].map((listener) => ({
      evaluate: async (script, argument) => {
        if (typeof script === "string") return undefined;
        return "since" in argument ? readingsOf(listener, argument.speaker) : publishes;
      },
    })),
  };
}
const toneFrames = frames(15, () => read(sine(440, 0.15)));
const silentFrames = frames(15, () => read(silent()));

test("a call whose audio decodes as the tone passes and reports dB and bin per pair", async () => {
  const verdicts = await proveAudioDecoded(
    fakeCall(true, () => toneFrames),
    { criteria: fixedCriteria, timeoutMs: 50 },
  );
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((verdict) => verdict.pass && verdict.peakDb > -35 && verdict.bin === 38));
});

test("a call whose bytes advance but whose audio is silent fails and names the pair, dB and bin", async () => {
  await assert.rejects(
    proveAudioDecoded(
      fakeCall(true, (listener) => (listener === 1 ? silentFrames : toneFrames)),
      { criteria: fixedCriteria, timeoutMs: 20 },
    ),
    (error) => error.reason === "audio-not-decoded" && /guest 2 hearing guest 1: -140 dB at bin 38/.test(error.message) && !/guest 1 hearing/.test(error.message),
  );
});

test("a muted guest that is still audible fails; a silent one passes", async () => {
  const call = (readings) => fakeCall(true, () => readings);
  assert.equal((await proveSilenceFrom(call(silentFrames), 0, { criteria: fixedCriteria, timeoutMs: 20 })).length, 1);
  await assert.rejects(proveSilenceFrom(call(toneFrames), 0, { criteria: fixedCriteria, timeoutMs: 20 }), (error) => error.reason === "audio-not-silent");
});

test("a muted guest whose remote track is gone passes as removed; a track that stays but yields too few frames fails", async () => {
  const gone = await proveSilenceFrom(
    fakeCall(true, () => [], false),
    0,
    { criteria: fixedCriteria, timeoutMs: 20 },
  );
  assert.deepEqual(
    gone.map((verdict) => verdict.track),
    ["removed"],
  );
  await assert.rejects(
    proveSilenceFrom(
      fakeCall(true, () => [], true),
      0,
      { criteria: fixedCriteria, timeoutMs: 20 },
    ),
    (error) => error.reason === "audio-not-silent",
  );
});

test("after a microphone turns back on, every other guest must decode it; the guest itself is not a listener", async () => {
  const verdicts = await hearAfterUnmute(
    fakeCall(true, () => toneFrames),
    0,
    { criteria: fixedCriteria, timeoutMs: 50 },
  );
  assert.deepEqual(
    verdicts.map(({ listener, speaker, pass }) => [listener, speaker, pass]),
    [[2, 1, true]],
  );
  assert.deepEqual(unheardAfterUnmute(0, verdicts), []);
});

test("a re-published microphone whose bytes advance but whose tone is not decoded at a listener fails and names it", async () => {
  // The listener's receiver is dead: its inbound bytes keep climbing (the callers' byte checks pass) while the analyser reads digital silence.
  const verdicts = await hearAfterUnmute(
    fakeCall(true, () => silentFrames),
    0,
    { criteria: fixedCriteria, timeoutMs: 20 },
  );
  assert.equal(unmuteHearMs, 5000);
  assert.deepEqual(unheardAfterUnmute(0, verdicts), ["Guest 2 did not decode guest 1 within 5 s of its microphone turning back on (-140 dB at bin 38, floor -140 dB)"]);
  // A listener with no live remote track yet yields no frames at all: that fails too, with the reason.
  const none = await hearAfterUnmute(
    fakeCall(true, () => []),
    0,
    { criteria: fixedCriteria, timeoutMs: 20 },
  );
  assert.deepEqual(unheardAfterUnmute(0, none), ["Guest 2 did not decode guest 1 within 5 s of its microphone turning back on (no audio frames were analysed)"]);
});
