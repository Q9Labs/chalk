import { isAbsolute } from "node:path";
import { VIDEO_ENCODERS, type VideoEncoder } from "../generated/render-contract.js";
import type { AnnotationInputFile } from "./inputs.js";

export interface Arguments {
  readonly requestPath: string;
  readonly resultPath: string;
  readonly outputPath: string;
  readonly ffmpegPath: string;
  readonly encoder: VideoEncoder;
  readonly threads?: number;
  readonly annotationFile?: AnnotationInputFile;
}

function composeOptions(values: readonly string[]): ReadonlyMap<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const [key, value] = optionPair(values, index);
    if (options.has(key)) throw composeUsage();
    options.set(key, value);
  }
  verifyKnownOptions(options);
  return options;
}

function optionPair(values: readonly string[], index: number): [string, string] {
  const key = values[index];
  const value = values[index + 1];
  if (key === undefined || value === undefined || !key.startsWith("--")) throw composeUsage();
  return [key, value];
}

function composeUsage(): TypeError {
  return new TypeError(`usage: compose --request <path> --result <path> --output <path> [--ffmpeg <path>] [--encoder ${VIDEO_ENCODERS.join("|")}] [--threads <n>] [--annotation-sidecar <path> --annotation-sha256 <sha256>]`);
}

function verifyKnownOptions(options: ReadonlyMap<string, string>): void {
  for (const key of options.keys()) {
    if (!["--request", "--result", "--output", "--ffmpeg", "--encoder", "--threads", "--annotation-sidecar", "--annotation-sha256"].includes(key)) throw new TypeError(`unknown compose option ${key}`);
  }
}

function absoluteOption(options: ReadonlyMap<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined || !isAbsolute(value)) throw new TypeError(`${key} must be an absolute path`);
  return value;
}

export function parseArguments(values: readonly string[]): Arguments {
  const options = composeOptions(values);
  const encoder = encoderOption(options);
  const threads = threadOption(options);
  const annotationFile = annotationOption(options);
  return {
    ...(annotationFile === undefined ? {} : { annotationFile }),
    requestPath: absoluteOption(options, "--request"),
    resultPath: absoluteOption(options, "--result"),
    outputPath: absoluteOption(options, "--output"),
    ffmpegPath: options.get("--ffmpeg") ?? "ffmpeg",
    encoder,
    ...(threads === undefined ? {} : { threads }),
  };
}

function encoderOption(options: ReadonlyMap<string, string>): VideoEncoder {
  const selected = options.get("--encoder");
  const encoder = VIDEO_ENCODERS.find((candidate) => candidate === (selected ?? "libx264"));
  if (encoder === undefined) throw new TypeError(`unsupported compose encoder ${selected}`);
  return encoder;
}

function threadOption(options: ReadonlyMap<string, string>): number | undefined {
  const raw = options.get("--threads");
  if (raw === undefined) return undefined;
  const threads = Number(raw);
  if (!validThreadCount(threads)) throw new TypeError("--threads must be between 1 and 64");
  return threads;
}

function annotationOption(options: ReadonlyMap<string, string>): AnnotationInputFile | undefined {
  const sidecar = options.get("--annotation-sidecar");
  const sha256 = options.get("--annotation-sha256");
  if (sidecar === undefined && sha256 === undefined) return undefined;
  if (!annotationDigestMatches(sidecar, sha256)) throw new TypeError("recording annotation sidecar requires a path and lowercase SHA-256");
  return { path: absoluteOption(options, "--annotation-sidecar"), sha256 };
}

function validThreadCount(threads: number): boolean {
  return Number.isSafeInteger(threads) && threads >= 1 && threads <= 64;
}

function annotationDigestMatches(sidecar: string | undefined, sha256: string | undefined): sha256 is string {
  return sidecar !== undefined && sha256 !== undefined && /^[0-9a-f]{64}$/.test(sha256);
}
