#!/usr/bin/env node

import { open, stat } from "node:fs/promises";
import path from "node:path";

import { fileSHA256 } from "./file-sha256.mjs";
import { parseOptionValue } from "./parse-option-value.mjs";
import { runBoundedCommand } from "./run-bounded-command.mjs";

const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024 * 1024;

function parseArguments(argv) {
  const options = {
    allowNoAudio: false,
    durationToleranceMs: 250,
    expectAudioCodec: "",
    expectDurationMs: null,
    expectFps: null,
    expectHeight: null,
    expectVideoCodec: "",
    expectWidth: null,
    input: "",
    maxAVEndDriftMs: 250,
    maxAVStartDriftMs: 100,
    maxBlackMs: null,
    maxFreezeMs: null,
    maxSilenceMs: null,
    requireFaststart: false,
    scanAnomalies: false,
  };
  const numeric = new Set(["duration-tolerance-ms", "expect-duration-ms", "expect-fps", "expect-height", "expect-width", "max-av-end-drift-ms", "max-av-start-drift-ms", "max-black-ms", "max-freeze-ms", "max-silence-ms"]);
  const strings = new Set(["expect-audio-codec", "expect-video-codec", "input"]);
  const booleans = new Set(["allow-no-audio", "require-faststart", "scan-anomalies"]);
  const names = {
    "allow-no-audio": "allowNoAudio",
    "duration-tolerance-ms": "durationToleranceMs",
    "expect-audio-codec": "expectAudioCodec",
    "expect-duration-ms": "expectDurationMs",
    "expect-fps": "expectFps",
    "expect-height": "expectHeight",
    "expect-video-codec": "expectVideoCodec",
    "expect-width": "expectWidth",
    input: "input",
    "max-av-end-drift-ms": "maxAVEndDriftMs",
    "max-av-start-drift-ms": "maxAVStartDriftMs",
    "max-black-ms": "maxBlackMs",
    "max-freeze-ms": "maxFreezeMs",
    "max-silence-ms": "maxSilenceMs",
    "require-faststart": "requireFaststart",
    "scan-anomalies": "scanAnomalies",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (booleans.has(name)) {
      options[names[name]] = true;
      continue;
    }
    if (!numeric.has(name) && !strings.has(name)) throw new Error(`unknown option: --${name}`);
    options[names[name]] = parseOptionValue(argv, index, name, numeric.has(name));
    index += 1;
  }
  if (options.input.trim() === "") throw new Error("--input is required");
  if (options.expectWidth !== null && !Number.isInteger(options.expectWidth)) throw new Error("--expect-width must be an integer");
  if (options.expectHeight !== null && !Number.isInteger(options.expectHeight)) throw new Error("--expect-height must be an integer");
  return options;
}

async function run(command, arguments_) {
  const result = await runBoundedCommand(command, arguments_, { maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES });
  return { ...result, stderr: result.stderr.toString("utf8"), stdout: result.stdout.toString("utf8") };
}

function seconds(value) {
  if (value === undefined || value === null || value === "N/A" || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function milliseconds(value) {
  const parsed = seconds(value);
  return parsed === null ? null : Math.round(parsed * 1_000);
}

function frameRate(value) {
  if (!value || value === "0/0") return null;
  const [numerator, denominator = "1"] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function streamBoundary(stream, packets) {
  let start = milliseconds(stream.start_time);
  let end = null;
  for (const packet of packets) {
    const packetStart = seconds(packet.pts_time) ?? seconds(packet.dts_time);
    if (packetStart === null) continue;
    const packetEnd = packetStart + (seconds(packet.duration_time) ?? 0);
    start = start === null ? Math.round(packetStart * 1_000) : Math.min(start, Math.round(packetStart * 1_000));
    end = end === null ? Math.round(packetEnd * 1_000) : Math.max(end, Math.round(packetEnd * 1_000));
  }
  if (end === null) {
    const duration = milliseconds(stream.duration);
    if (start !== null && duration !== null) end = start + duration;
  }
  return { endMs: end, startMs: start };
}

function timestampFacts(packets) {
  let previousDTS = null;
  let regressions = 0;
  let timestamped = 0;
  let keyframes = 0;
  for (const packet of packets) {
    if (String(packet.flags ?? "").includes("K")) keyframes += 1;
    const dts = seconds(packet.dts_time);
    if (dts === null) continue;
    timestamped += 1;
    if (previousDTS !== null && dts + 0.000_001 < previousDTS) regressions += 1;
    previousDTS = dts;
  }
  return { dts_regressions: regressions, keyframes, packets: packets.length, timestamped_packets: timestamped };
}

async function topLevelMP4Boxes(file, size) {
  const handle = await open(file, "r");
  const boxes = [];
  let offset = 0;
  try {
    while (offset + 8 <= size && boxes.length < 10_000) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerSize = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) throw new Error("truncated extended MP4 box header");
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 box is too large to inspect safely");
        boxSize = Number(extended);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (boxSize < headerSize || offset + boxSize > size) throw new Error(`invalid top-level MP4 box ${type}`);
      boxes.push({ offset, size: boxSize, type });
      offset += boxSize;
    }
  } finally {
    await handle.close();
  }
  return boxes;
}

function intervals(stderr, kind) {
  const expressions = {
    black: /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g,
    freeze: /freeze_start:\s*([\d.]+).*?freeze_end:\s*([\d.]+).*?freeze_duration:\s*([\d.]+)/gs,
    silence: /silence_start:\s*([\d.]+).*?silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/gs,
  };
  return [...stderr.matchAll(expressions[kind])].map((match) => ({
    duration_ms: Math.round(Number(match[3]) * 1_000),
    end_ms: Math.round(Number(match[2]) * 1_000),
    start_ms: Math.round(Number(match[1]) * 1_000),
  }));
}

async function anomalyScan(input, hasAudio) {
  const video = await run("ffmpeg", ["-hide_banner", "-nostdin", "-xerror", "-i", input, "-map", "0:v:0", "-an", "-vf", "blackdetect=d=0.5:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=0.5", "-f", "null", "-"]);
  const black = intervals(video.stderr, "black");
  const freeze = intervals(video.stderr, "freeze");
  let silence = [];
  if (hasAudio) {
    const audio = await run("ffmpeg", ["-hide_banner", "-nostdin", "-xerror", "-i", input, "-map", "0:a:0", "-vn", "-af", "silencedetect=n=-50dB:d=0.5", "-f", "null", "-"]);
    silence = intervals(audio.stderr, "silence");
  }
  const longest = (entries) => entries.reduce((maximum, entry) => Math.max(maximum, entry.duration_ms), 0);
  return {
    black: { intervals: black.length, longest_ms: longest(black) },
    freeze: { intervals: freeze.length, longest_ms: longest(freeze) },
    silence: hasAudio ? { intervals: silence.length, longest_ms: longest(silence) } : null,
  };
}

function addAssertion(assertions, name, passed, actual, expected) {
  assertions.push({ actual, expected, name, passed });
}

async function inspect(options) {
  const input = path.resolve(options.input);
  const inputStat = await stat(input);
  if (!inputStat.isFile()) throw new Error("--input must name a regular file");
  const probe = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    "-show_packets",
    "-show_entries",
    "stream=index,codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,start_time,duration,nb_frames,nb_read_packets,tags:format=format_name,start_time,duration,size,bit_rate,tags:packet=stream_index,pts_time,dts_time,duration_time,flags",
    input,
  ]);
  const facts = JSON.parse(probe.stdout);
  const streams = Array.isArray(facts.streams) ? facts.streams : [];
  const packets = Array.isArray(facts.packets) ? facts.packets : [];
  const video = streams.find((stream) => stream.codec_type === "video") ?? null;
  const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;
  const videoPackets = video === null ? [] : packets.filter((packet) => packet.stream_index === video.index);
  const audioPackets = audio === null ? [] : packets.filter((packet) => packet.stream_index === audio.index);
  const videoBoundary = video === null ? null : streamBoundary(video, videoPackets);
  const audioBoundary = audio === null ? null : streamBoundary(audio, audioPackets);
  const formatDurationMs = milliseconds(facts.format?.duration);
  const assertions = [];

  addAssertion(assertions, "video_stream_present", video !== null, video !== null, true);
  addAssertion(assertions, "audio_stream_present", options.allowNoAudio || audio !== null, audio !== null, !options.allowNoAudio);
  if (video !== null) {
    addAssertion(assertions, "video_dts_monotonic", timestampFacts(videoPackets).dts_regressions === 0, timestampFacts(videoPackets).dts_regressions, 0);
    addAssertion(assertions, "video_packets_present", videoPackets.length > 0, videoPackets.length, "> 0");
    addAssertion(assertions, "video_keyframe_present", timestampFacts(videoPackets).keyframes > 0, timestampFacts(videoPackets).keyframes, "> 0");
    if (options.expectWidth !== null) addAssertion(assertions, "video_width", video.width === options.expectWidth, video.width, options.expectWidth);
    if (options.expectHeight !== null) addAssertion(assertions, "video_height", video.height === options.expectHeight, video.height, options.expectHeight);
    if (options.expectVideoCodec !== "") addAssertion(assertions, "video_codec", video.codec_name === options.expectVideoCodec, video.codec_name, options.expectVideoCodec);
    if (options.expectFps !== null) {
      const actualFPS = frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate);
      addAssertion(assertions, "video_fps", actualFPS !== null && Math.abs(actualFPS - options.expectFps) <= 0.01, actualFPS, options.expectFps);
    }
  }
  if (audio !== null) {
    addAssertion(assertions, "audio_dts_monotonic", timestampFacts(audioPackets).dts_regressions === 0, timestampFacts(audioPackets).dts_regressions, 0);
    addAssertion(assertions, "audio_packets_present", audioPackets.length > 0, audioPackets.length, "> 0");
    if (options.expectAudioCodec !== "") addAssertion(assertions, "audio_codec", audio.codec_name === options.expectAudioCodec, audio.codec_name, options.expectAudioCodec);
  }
  if (options.expectDurationMs !== null) {
    const difference = formatDurationMs === null ? null : Math.abs(formatDurationMs - options.expectDurationMs);
    addAssertion(assertions, "format_duration", difference !== null && difference <= options.durationToleranceMs, formatDurationMs, `${options.expectDurationMs} ± ${options.durationToleranceMs}ms`);
  }
  if (videoBoundary !== null && audioBoundary !== null && videoBoundary.startMs !== null && audioBoundary.startMs !== null) {
    const drift = Math.abs(videoBoundary.startMs - audioBoundary.startMs);
    addAssertion(assertions, "av_start_drift", drift <= options.maxAVStartDriftMs, drift, `<= ${options.maxAVStartDriftMs}ms`);
  }
  if (videoBoundary !== null && audioBoundary !== null && videoBoundary.endMs !== null && audioBoundary.endMs !== null) {
    const drift = Math.abs(videoBoundary.endMs - audioBoundary.endMs);
    addAssertion(assertions, "av_end_drift", drift <= options.maxAVEndDriftMs, drift, `<= ${options.maxAVEndDriftMs}ms`);
  }

  const boxes = await topLevelMP4Boxes(input, inputStat.size);
  const moov = boxes.find((box) => box.type === "moov") ?? null;
  const mdat = boxes.find((box) => box.type === "mdat") ?? null;
  const faststart = moov !== null && mdat !== null && moov.offset < mdat.offset;
  if (options.requireFaststart) addAssertion(assertions, "mp4_faststart", faststart, faststart, true);

  const anomalies = options.scanAnomalies ? await anomalyScan(input, audio !== null) : null;
  if (anomalies !== null && options.maxBlackMs !== null) addAssertion(assertions, "maximum_black_interval", anomalies.black.longest_ms <= options.maxBlackMs, anomalies.black.longest_ms, `<= ${options.maxBlackMs}ms`);
  if (anomalies !== null && options.maxFreezeMs !== null) addAssertion(assertions, "maximum_freeze_interval", anomalies.freeze.longest_ms <= options.maxFreezeMs, anomalies.freeze.longest_ms, `<= ${options.maxFreezeMs}ms`);
  if (anomalies?.silence !== null && anomalies?.silence !== undefined && options.maxSilenceMs !== null) addAssertion(assertions, "maximum_silence_interval", anomalies.silence.longest_ms <= options.maxSilenceMs, anomalies.silence.longest_ms, `<= ${options.maxSilenceMs}ms`);

  const failed = assertions.filter((assertion) => !assertion.passed);
  return {
    evidence_version: "recording-media-evidence.v1",
    passed: failed.length === 0,
    input: {
      bytes: inputStat.size,
      sha256: await fileSHA256(input),
    },
    format: {
      bit_rate: Number(facts.format?.bit_rate) || null,
      duration_ms: formatDurationMs,
      faststart,
      format_name: facts.format?.format_name ?? null,
      top_level_boxes: boxes.map((box) => box.type),
    },
    video:
      video === null
        ? null
        : {
            boundary: videoBoundary,
            codec: video.codec_name,
            fps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
            height: video.height,
            timestamps: timestampFacts(videoPackets),
            width: video.width,
          },
    audio:
      audio === null
        ? null
        : {
            boundary: audioBoundary,
            codec: audio.codec_name,
            timestamps: timestampFacts(audioPackets),
          },
    anomalies,
    assertions,
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const evidence = await inspect(options);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
