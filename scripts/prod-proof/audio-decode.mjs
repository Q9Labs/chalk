// Audio judgment for the proofs: a call passes only when the audio is decoded, not when its bytes advance.
//
// Inbound-rtp bytesReceived grows for silence, garbage and for audio that Chromium never plays out, and in headless
// Chromium without playout totalAudioEnergy stays 0. So each sender publishes a known tone (fixture.mjs: guest n sends
// toneHz(n)), and each receiver pipes the remote track into a WebAudio AnalyserNode, which runs headless and needs no
// output device (a muted media element keeps the track flowing, see startToneProbe), then reads the energy of the FFT
// bins around that tone.
//
// This file holds the pure rules (tested with a fake analyser in audio-decode.test.mjs) and the page probe they feed.
// The bytes-advancing check stays where it is; callers add this one as a further condition.
import { check } from "./runtime.mjs";

export const toneHz = (guest) => 440 * (guest + 1); // The frequency fixture.mjs publishes for a guest.

export const decodeCriteria = {
  fftSize: 4096, // 11.7 Hz per bin at 48 kHz.
  intervalMs: 100,
  sustainFrames: 10, // Consecutive frames, so one second, a tone must hold to count as heard (or a silence to count as quiet).
  toneMinDb: -50, // dBFS at the tone's bins. The fixture sends 0.15 amplitude, about -25 dB at a bin.
  marginDb: 25, // The tone must also stand this far above the median of every other bin.
  silenceMaxDb: -70, // A silenced sender leaves the tone's bins at or below this.
  speechMinDb: -60, // Speech has no tone: the loudest bin between 100 Hz and 4 kHz must reach this.
  floorDb: -140, // What an empty bin (-Infinity from the analyser) counts as.
};

/**
 * Reads one spectrum, as dB per bin from AnalyserNode.getFloatFrequencyData. Runs in Node and, serialised, in the page,
 * so it must stay free of outer references.
 * @returns {{ bin: number, toneDb: number|null, floorDb: number, marginDb: number|null, bandDb: number }}
 */
export function spectrumReading(spectrum, { hz, sampleRate }) {
  const empty = -140;
  const db = Array.from(spectrum, (value) => (Number.isFinite(value) ? Math.max(value, empty) : empty));
  const binOf = (frequency) => Math.round((frequency * 2 * db.length) / sampleRate);
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const band = db.slice(binOf(100), binOf(4000) + 1);
  const bandDb = band.length ? Math.max(...band) : empty;
  if (hz == null) return { bin: -1, toneDb: null, floorDb: median(db), marginDb: null, bandDb };
  const bin = binOf(hz);
  const toneDb = Math.max(...db.slice(Math.max(0, bin - 1), bin + 2));
  const floorDb = median(db.filter((_, index) => Math.abs(index - bin) > 3));
  return { bin, toneDb, floorDb, marginDb: toneDb - floorDb, bandDb };
}

const longestRun = (readings, test) => readings.reduce((state, reading) => (test(reading) ? { run: state.run + 1, best: Math.max(state.best, state.run + 1) } : { run: 0, best: state.best }), { run: 0, best: 0 }).best;

const summary = (readings, sustainedFrames) => {
  const peak = readings.reduce((best, reading) => ((reading.toneDb ?? reading.bandDb) > (best.toneDb ?? best.bandDb) ? reading : best), readings[0]);
  return { frames: readings.length, sustainedFrames, bin: peak.bin, peakDb: round(peak.toneDb ?? peak.bandDb), floorDb: round(peak.floorDb), marginDb: peak.marginDb == null ? null : round(peak.marginDb), lastDb: round(readings.at(-1).toneDb ?? readings.at(-1).bandDb) };
};
const round = (value) => Math.round(value * 10) / 10;

/** The tone is heard: enough consecutive frames with energy at its bins, above the noise floor. */
export function judgeTone(readings, criteria = decodeCriteria) {
  if (readings.length === 0) return { pass: false, why: "no audio frames were analysed", frames: 0 };
  const sustained = longestRun(readings, (reading) => reading.toneDb >= criteria.toneMinDb && reading.marginDb >= criteria.marginDb);
  return { pass: sustained >= criteria.sustainFrames, ...summary(readings, sustained) };
}

/** The sender is silent: the newest frames, enough of them, all hold no energy at the tone's bins. */
export function judgeSilence(readings, criteria = decodeCriteria) {
  if (readings.length < criteria.sustainFrames) return { pass: false, why: "too few audio frames were analysed", frames: readings.length };
  const tail = readings.slice(-criteria.sustainFrames);
  return { pass: tail.every((reading) => reading.toneDb <= criteria.silenceMaxDb), ...summary(readings, tail.filter((reading) => reading.toneDb <= criteria.silenceMaxDb).length) };
}

/** Speech is heard: energy between 100 Hz and 4 kHz in at least sustainFrames frames (speech pauses, so they need not be consecutive). */
export function judgeSpeech(readings, criteria = decodeCriteria) {
  if (readings.length === 0) return { pass: false, why: "no audio frames were analysed", frames: 0 };
  const loud = readings.filter((reading) => reading.bandDb >= criteria.speechMinDb).length;
  return { pass: loud >= criteria.sustainFrames, ...summary(readings, loud) };
}

/**
 * The page probe, serialised into the page. Once started it samples the analyser of every live remote microphone every
 * intervalMs and keeps the newest readings per speaker in window.proofTone.readings (speaker = participant id).
 * `reading` is spectrumReading's source; `hzOf` maps a speaker's participant id to the tone it publishes.
 */
function startToneProbe({ hzOf, fftSize, intervalMs, keep }, reading) {
  if (window.proofTone) return;
  const context = new AudioContext();
  const listeners = new Map();
  const readings = {};
  const tick = () => {
    if (context.state !== "running") context.resume().catch(() => {});
    for (const entry of window.proofClient.getSnapshot().media.remote) {
      if (entry.source !== "microphone" || entry.track.readyState !== "live") continue;
      if (!listeners.has(entry.track)) {
        const analyser = new AnalyserNode(context, { fftSize, smoothingTimeConstant: 0, minDecibels: -140 });
        const stream = new MediaStream([entry.track]);
        // Chromium hands a remote WebRTC track to WebAudio only while a media element plays it: without one the analyser reads
        // digital silence (-Infinity) though the bytes advance. A muted element is enough and makes no sound.
        const element = new Audio();
        element.srcObject = stream;
        element.muted = true;
        element.play().catch(() => {});
        document.body.append(element);
        context.createMediaStreamSource(stream).connect(analyser);
        listeners.set(entry.track, analyser);
      }
      const analyser = listeners.get(entry.track);
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      const rows = (readings[entry.participantId] ??= []);
      rows.push({ at: Date.now(), ...window.proofToneReading(spectrum, { hz: hzOf[entry.participantId] ?? null, sampleRate: context.sampleRate }) });
      if (rows.length > keep) rows.shift();
    }
  };
  window.proofToneReading = reading;
  window.proofTone = { context, readings, timer: setInterval(tick, intervalMs) };
  tick();
}

/** Starts the probe on a page for the given speakers (`hzOf`: participant id to tone, or an empty object for speech). */
async function startProbe(page, hzOf, criteria = decodeCriteria) {
  const options = { hzOf, fftSize: criteria.fftSize, intervalMs: criteria.intervalMs, keep: 300 };
  await page.evaluate(`(${startToneProbe})(${JSON.stringify(options)}, ${spectrumReading})`);
}

/** The readings of one speaker taken since `sinceMs` (epoch). */
async function readingsOf(page, speaker, sinceMs) {
  return page.evaluate(({ speaker: id, since }) => (window.proofTone?.readings[id] ?? []).filter((row) => row.at >= since), { speaker, since: sinceMs });
}

/** The listener-and-speaker pairs among `members` (guest indexes): every member hears every other member. `pairs` below can name others. */
export const pairsOf = (members) => members.flatMap((listener) => members.filter((speaker) => speaker !== listener).map((speaker) => ({ listener, speaker })));
const allGuests = (guests) => guests.pages.map((_, index) => index);

/** True while the page holds a live remote microphone track of this speaker. */
const hearsTrack = (page, speaker) => page.evaluate(({ speaker: id }) => window.proofClient.getSnapshot().media.remote.some((entry) => entry.participantId === id && entry.source === "microphone" && entry.track.readyState === "live"), { speaker });

const windowMs = (criteria) => criteria.sustainFrames * criteria.intervalMs;

/**
 * Polls one pair until `judge` passes or the timeout ends; the last verdict is returned either way, and it says what was measured.
 * @param {(readings: object[], page: object, speaker: string) => object|Promise<object>} judge
 */
async function settle(guests, { listener, speaker }, judge, timeoutMs, criteria) {
  const page = guests.pages[listener];
  const id = guests.participants[speaker];
  const deadline = Date.now() + timeoutMs;
  let verdict;
  for (;;) {
    verdict = await judge(await readingsOf(page, id, Date.now() - windowMs(criteria) - criteria.intervalMs * 5), page, id);
    if (verdict.pass || Date.now() >= deadline) return { listener: listener + 1, speaker: speaker + 1, ...verdict };
    await new Promise((resolve) => setTimeout(resolve, criteria.intervalMs * 2));
  }
}

const describe = (verdicts) => verdicts.map((v) => `guest ${v.listener} hearing guest ${v.speaker}: ${v.why ?? `${v.peakDb} dB at bin ${v.bin}, floor ${v.floorDb} dB, ${v.sustainedFrames} sustained frames`}`).join("; ");

/**
 * Every guest hears every other guest. With `guests.tones` the sender's tone must stand out in the spectrum; otherwise
 * speech energy must be present. The caller keeps its bytes-advancing check; this is the further condition.
 * @returns the measured verdicts, which the caller saves as evidence
 */
export async function proveAudioDecoded(guests, { members = allGuests(guests), pairs = pairsOf(members), timeoutMs = 20_000, criteria = decodeCriteria } = {}) {
  const hzOf = Object.fromEntries(guests.participants.map((id, speaker) => [id, guests.tones ? toneHz(speaker) : null]));
  await Promise.all([...new Set(pairs.map((pair) => pair.listener))].map((listener) => startProbe(guests.pages[listener], hzOf, criteria)));
  const judge = guests.tones ? judgeTone : judgeSpeech;
  const verdicts = await Promise.all(pairs.map((pair) => settle(guests, pair, (readings) => judge(readings, criteria), timeoutMs, criteria)));
  const failed = verdicts.filter((verdict) => !verdict.pass);
  check(failed.length === 0, `Audio bytes advance but are not decoded as ${guests.tones ? "the published tone" : "speech"}: ${describe(failed)}`, "audio-not-decoded");
  return verdicts;
}

/** After guest `speaker` mutes, every other member hears silence from that guest. */
export async function proveSilenceFrom(guests, speaker, { members = allGuests(guests), timeoutMs = 20_000, criteria = decodeCriteria } = {}) {
  const pairs = pairsOf(members).filter((pair) => pair.speaker === speaker);
  // The SDK drops a muted speaker's remote track, so the listener may have nothing left to analyse: that is silence too.
  // A caller proves the speaker was heard (proveAudioDecoded) before muting, so a removed track is not a vacuous pass.
  const judge = async (readings, page, id) => {
    const verdict = judgeSilence(readings, criteria);
    if (verdict.pass || (await hearsTrack(page, id))) return { ...verdict, track: "live" };
    return { pass: true, track: "removed", frames: readings.length };
  };
  const verdicts = await Promise.all(pairs.map((pair) => settle(guests, pair, judge, timeoutMs, criteria)));
  const failed = verdicts.filter((verdict) => !verdict.pass);
  check(failed.length === 0, `A muted guest ${speaker + 1} is still audible: ${describe(failed)}`, "audio-not-silent");
  return verdicts;
}
