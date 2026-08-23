import { join } from "node:path";

export const PROFILE_MINUTES = Object.freeze({ min: 30, max: 45, default: 30 });
export const SHAKEDOWN_SECONDS = Object.freeze({ min: 60, max: 300, default: 60 });
export const PARTICIPANT_LIMITS = Object.freeze({ min: 3, max: 4, default: 4 });

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function numberOption(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`${name} must be a finite number`);
  return number;
}

function integerOption(value, name) {
  const number = numberOption(value, name);
  if (!Number.isInteger(number)) throw new UsageError(`${name} must be an integer`);
  return number;
}

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
  return value;
}

function validateBase(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new UsageError("--base must be an http or https URL");
  }
}

export function usageText() {
  return [
    "Usage: node cli.mjs <profile|shakedown> [options]",
    "",
    "profile: 30-45 minutes; shakedown: 60-300 seconds.",
    "Options:",
    "  --minutes <n>         profile duration (30-45)",
    "  --seconds <n>         shakedown duration (60-300)",
    "  --duration <n>        duration in the mode's unit",
    "  --participants <n>    isolated Participants (3-4)",
    "  --base <url>          local Chalk web base URL",
    "  --storage-state <p>   Playwright storage state for the smoke-test login",
    "  --output-root <p>     private directory for run artifacts",
    "  --help                print this text",
  ].join("\n");
}

export function parseCli(argv, env = process.env) {
  const first = argv[0];
  if (first === "--help" || first === "-h") return { help: true };
  if (first !== "profile" && first !== "shakedown") throw new UsageError("mode must be profile or shakedown");

  const mode = first;
  const options = {
    mode,
    participants: PARTICIPANT_LIMITS.default,
    base: validateBase(env.CHALK_PERF_BASE ?? "http://127.0.0.1:13070"),
    storageState: env.CHALK_PERF_STORAGE_STATE,
    outputRoot: env.CHALK_PERF_OUTPUT_ROOT,
    duration: mode === "profile" ? PROFILE_MINUTES.default : SHAKEDOWN_SECONDS.default,
  };
  let explicitDuration = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--participants") {
      options.participants = integerOption(requireValue(argv, index, argument), argument);
      index += 1;
      continue;
    }
    if (argument === "--base") {
      options.base = validateBase(requireValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--storage-state") {
      options.storageState = requireValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--output-root") {
      options.outputRoot = requireValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--duration" || argument === "--minutes" || argument === "--seconds") {
      const expected = mode === "profile" ? "--minutes" : "--seconds";
      if (argument !== "--duration" && argument !== expected) throw new UsageError(`${argument} is only valid for ${argument === "--minutes" ? "profile" : "shakedown"}`);
      options.duration = numberOption(requireValue(argv, index, argument), argument);
      explicitDuration = true;
      index += 1;
      continue;
    }
    throw new UsageError(`unknown option ${argument}`);
  }

  if (options.participants < PARTICIPANT_LIMITS.min || options.participants > PARTICIPANT_LIMITS.max) throw new UsageError("--participants must be between 3 and 4");
  const bounds = mode === "profile" ? PROFILE_MINUTES : SHAKEDOWN_SECONDS;
  if (options.duration < bounds.min || options.duration > bounds.max) throw new UsageError(`${mode} duration must be between ${bounds.min} and ${bounds.max} ${mode === "profile" ? "minutes" : "seconds"}`);
  if (explicitDuration && mode === "shakedown" && !Number.isInteger(options.duration)) throw new UsageError("shakedown duration must be an integer number of seconds");
  options.durationMs = mode === "profile" ? options.duration * 60_000 : options.duration * 1_000;
  return options;
}

export function createRunId(now = new Date(), random = Math.random()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = Math.floor(random * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `${stamp}-${suffix}`;
}

export function runDirectory(rootDir, options, now = new Date(), random = Math.random()) {
  const outputRoot = options.outputRoot ?? join(rootDir, ".private", "chalk-perf", "runs");
  return join(outputRoot, `${options.mode}-${createRunId(now, random)}`);
}
