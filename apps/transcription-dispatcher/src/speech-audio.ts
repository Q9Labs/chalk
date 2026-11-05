import { FLACDecoder } from "@wasm-audio-decoders/flac";
import { providerSchemaError } from "./errors.js";

const RATE = 16_000;
const FRAME = 320;
const SILENCE_POWER = 10 ** (-45 / 10);
const PADDING = 2_400;
const MAX_BATCH_SAMPLES = 60 * RATE;

interface Span {
  sourceStart: number;
  sourceEnd: number;
  packedStart: number;
}

export interface SpeechBatch {
  audio: Uint8Array;
  durationSeconds: number;
  sourceSeconds(seconds: number, edge: "start" | "end"): number;
}

/** Renderer contract: native FLAC, 16 kHz mono. Validate STREAMINFO before allocating PCM. */
export async function prepareSpeechAudio(audio: Uint8Array, maxSeconds: number): Promise<{ batches: SpeechBatch[]; durationMs: number }> {
  const header = Buffer.from(audio.buffer, audio.byteOffset, Math.min(audio.byteLength, 42));
  if (header.length < 42 || header.toString("ascii", 0, 4) !== "fLaC" || (header[4]! & 127) !== 0 || header.readUIntBE(5, 3) !== 34) throw providerSchemaError("invalid FLAC source", "audio", "renderer FLAC STREAMINFO", undefined);
  const stream = header.readBigUInt64BE(18);
  const rate = Number(stream >> 44n);
  const channels = Number((stream >> 41n) & 7n) + 1;
  const samples = Number(stream & 0xfffffffffn);
  if (rate !== RATE || channels !== 1 || samples < 1 || samples > maxSeconds * RATE) throw providerSchemaError("FLAC source exceeded PCM bounds", "audio", "bounded 16 kHz mono FLAC", undefined);
  const decoder = new FLACDecoder();
  try {
    await decoder.ready;
    // codec-parser 2.5 needs lookahead beyond very short constant-signal final frames.
    // Zero padding is not audio; libFLAC still verifies frames and exact STREAMINFO samples.
    const decoded = await decoder.decodeFile(Buffer.concat([audio, Buffer.alloc(32)]));
    const pcm = decoded.channelData[0];
    if (decoded.errors.length || decoded.sampleRate !== RATE || decoded.channelData.length !== 1 || decoded.samplesDecoded !== samples || !pcm || pcm.length !== samples) throw providerSchemaError("FLAC decoding failed", "audio", "complete renderer PCM", undefined);
    return { batches: speechBatches(pcm), durationMs: Math.round((samples / RATE) * 1000) };
  } finally {
    decoder.free();
  }
}

function speechBatches(pcm: Float32Array): SpeechBatch[] {
  const runs: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < pcm.length; start += FRAME) {
    const end = Math.min(start + FRAME, pcm.length);
    let power = 0;
    for (let i = start; i < end; i++) power += pcm[i]! ** 2;
    if (power / (end - start) < SILENCE_POWER) continue;
    const previous = runs.at(-1);
    if (previous && start - previous.end < RATE) previous.end = end;
    else runs.push({ start, end });
  }
  const batches: SpeechBatch[] = [];
  let spans: Span[] = [];
  let packed = 0;
  const flush = () => {
    if (!packed) return;
    batches.push(makeBatch(pcm, spans, packed));
    spans = [];
    packed = 0;
  };
  for (const run of runs) {
    let sourceStart = Math.max(0, run.start - PADDING);
    const sourceEnd = Math.min(pcm.length, run.end + PADDING);
    while (sourceStart < sourceEnd) {
      const count = Math.min(sourceEnd - sourceStart, MAX_BATCH_SAMPLES - packed);
      spans.push({ sourceStart, sourceEnd: sourceStart + count, packedStart: packed });
      sourceStart += count;
      packed += count;
      if (packed === MAX_BATCH_SAMPLES) flush();
    }
  }
  flush();
  return batches;
}

function makeBatch(pcm: Float32Array, spans: Span[], samples: number): SpeechBatch {
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(RATE, 24);
  audio.writeUInt32LE(RATE * 2, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(samples * 2, 40);
  for (const span of spans) {
    for (let i = span.sourceStart; i < span.sourceEnd; i++) audio.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i]!)) * 32767), 44 + 2 * (span.packedStart + i - span.sourceStart));
  }
  return {
    audio,
    durationSeconds: samples / RATE,
    sourceSeconds(seconds, edge) {
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > samples / RATE + 0.05) throw providerSchemaError("MAI timing exceeded uploaded speech", "timestamp", "uploaded duration", seconds);
      const sample = Math.min(samples, seconds * RATE);
      for (const span of spans) {
        const end = span.packedStart + span.sourceEnd - span.sourceStart;
        if (sample < end || (edge === "end" && sample === end) || span === spans.at(-1)) return (span.sourceStart + sample - span.packedStart) / RATE;
      }
      throw providerSchemaError("MAI timestamp has no source", "timestamp", "source-mapped timestamp", seconds);
    },
  };
}
