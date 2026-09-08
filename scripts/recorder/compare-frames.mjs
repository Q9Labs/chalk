#!/usr/bin/env node

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { fileSHA256 } from "./file-sha256.mjs";
import { parseOptionValue } from "./parse-option-value.mjs";
import { runBoundedCommand } from "./run-bounded-command.mjs";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function parseArguments(argv) {
  const options = {
    actual: "",
    differenceExplanation: "",
    diffOutput: "",
    expectHeight: null,
    expectWidth: null,
    expected: "",
    maxChangedPixels: 0,
    maxMeanAbsoluteError: 0,
  };
  const names = {
    actual: "actual",
    "difference-explanation": "differenceExplanation",
    "diff-output": "diffOutput",
    "expect-height": "expectHeight",
    "expect-width": "expectWidth",
    expected: "expected",
    "max-changed-pixels": "maxChangedPixels",
    "max-mean-absolute-error": "maxMeanAbsoluteError",
  };
  const numeric = new Set(["expect-height", "expect-width", "max-changed-pixels", "max-mean-absolute-error"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") || !(argument.slice(2) in names)) throw new Error(`unknown argument: ${argument}`);
    const name = argument.slice(2);
    options[names[name]] = parseOptionValue(argv, index, name, numeric.has(name));
    index += 1;
  }
  if (options.expected === "" || options.actual === "") throw new Error("--expected and --actual are required");
  if (options.expectWidth !== null && !Number.isInteger(options.expectWidth)) throw new Error("--expect-width must be an integer");
  if (options.expectHeight !== null && !Number.isInteger(options.expectHeight)) throw new Error("--expect-height must be an integer");
  if (!Number.isInteger(options.maxChangedPixels)) throw new Error("--max-changed-pixels must be an integer");
  if ((options.maxChangedPixels > 0 || options.maxMeanAbsoluteError > 0) && options.differenceExplanation.trim() === "") {
    throw new Error("nonzero comparison tolerances require --difference-explanation");
  }
  return options;
}

function run(command, arguments_) {
  return runBoundedCommand(command, arguments_, { maxOutputBytes: MAX_OUTPUT_BYTES });
}

async function decode(file) {
  const facts = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file])).stdout.toString("utf8"));
  const stream = facts.streams?.[0];
  if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height)) throw new Error("frame dimensions are unavailable");
  const decoded = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  const expectedBytes = stream.width * stream.height * 4;
  if (decoded.stdout.length !== expectedBytes) throw new Error(`decoded frame has ${decoded.stdout.length} bytes, expected ${expectedBytes}`);
  return { bytes: decoded.stdout, height: stream.height, width: stream.width };
}

function compare(expected, actual) {
  let changedPixels = 0;
  let channelDelta = 0;
  let squaredDelta = 0;
  let maximumChannelDelta = 0;
  let minimumX = expected.width;
  let minimumY = expected.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let pixel = 0; pixel < expected.width * expected.height; pixel += 1) {
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(expected.bytes[offset + channel] - actual.bytes[offset + channel]);
      channelDelta += delta;
      squaredDelta += delta * delta;
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      changed ||= delta !== 0;
    }
    if (changed) {
      changedPixels += 1;
      const x = pixel % expected.width;
      const y = Math.floor(pixel / expected.width);
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  const channels = expected.bytes.length;
  return {
    changed_fraction: changedPixels / (expected.width * expected.height),
    changed_pixels: changedPixels,
    difference_bounds: changedPixels === 0 ? null : { max_x: maximumX, max_y: maximumY, min_x: minimumX, min_y: minimumY },
    max_channel_delta: maximumChannelDelta,
    mean_absolute_error: channelDelta / channels,
    root_mean_square_error: Math.sqrt(squaredDelta / channels),
  };
}

async function writeDifference(expected, actual, output) {
  await run("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", expected, "-i", actual, "-filter_complex", "[0:v][1:v]blend=all_mode=difference", "-frames:v", "1", output]);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const expectedPath = path.resolve(options.expected);
  const actualPath = path.resolve(options.actual);
  const [expectedStat, actualStat, expected, actual] = await Promise.all([stat(expectedPath), stat(actualPath), decode(expectedPath), decode(actualPath)]);
  if (!expectedStat.isFile() || !actualStat.isFile()) throw new Error("both frame inputs must be regular files");
  const dimensionsMatch = expected.width === actual.width && expected.height === actual.height;
  const assertions = [{ actual: dimensionsMatch, expected: true, name: "matching_dimensions", passed: dimensionsMatch }];
  if (options.expectWidth !== null) {
    assertions.push({ actual: actual.width, expected: options.expectWidth, name: "frame_width", passed: actual.width === options.expectWidth });
  }
  if (options.expectHeight !== null) {
    assertions.push({ actual: actual.height, expected: options.expectHeight, name: "frame_height", passed: actual.height === options.expectHeight });
  }
  let metrics = null;
  if (dimensionsMatch) {
    metrics = compare(expected, actual);
    assertions.push({
      actual: metrics.changed_pixels,
      expected: `<= ${options.maxChangedPixels}`,
      name: "changed_pixels",
      passed: metrics.changed_pixels <= options.maxChangedPixels,
    });
    assertions.push({
      actual: metrics.mean_absolute_error,
      expected: `<= ${options.maxMeanAbsoluteError}`,
      name: "mean_absolute_error",
      passed: metrics.mean_absolute_error <= options.maxMeanAbsoluteError,
    });
  }
  if (options.diffOutput !== "" && dimensionsMatch) await writeDifference(expectedPath, actualPath, path.resolve(options.diffOutput));
  const passed = assertions.every((assertion) => assertion.passed);
  const evidence = {
    evidence_version: "recording-frame-comparison.v1",
    passed,
    dimensions: {
      actual: { height: actual.height, width: actual.width },
      expected: { height: expected.height, width: expected.width },
    },
    expected_frame: {
      file_sha256: await fileSHA256(expectedPath),
      rgba_sha256: createHash("sha256").update(expected.bytes).digest("hex"),
    },
    actual_frame: {
      file_sha256: await fileSHA256(actualPath),
      rgba_sha256: createHash("sha256").update(actual.bytes).digest("hex"),
    },
    tolerance: {
      difference_explanation: options.differenceExplanation || null,
      max_changed_pixels: options.maxChangedPixels,
      max_mean_absolute_error: options.maxMeanAbsoluteError,
    },
    metrics,
    assertions,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
