import type { SyncRandom } from "./types";

export type SyncBackoffOptions = {
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
};

const defaultOptions: Required<SyncBackoffOptions> = {
  minDelayMs: 250,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};

export function calculateBackoffDelay(attempt: number, random: SyncRandom, options: SyncBackoffOptions = {}): number {
  assertValidAttempt(attempt);
  const resolved = resolveOptions(options);
  const randomValue = readRandomValue(random);
  return jitteredDelay(attempt, randomValue, resolved);
}

function assertValidAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("backoff attempt must be a positive integer");
  }
}

function resolveOptions(options: SyncBackoffOptions): Required<SyncBackoffOptions> {
  const resolved = { ...defaultOptions, ...options };
  if (!hasValidDelayBounds(resolved) || !hasValidJitterRatio(resolved.jitterRatio)) {
    throw new RangeError("invalid backoff options");
  }
  return resolved;
}

function hasValidDelayBounds(options: Required<SyncBackoffOptions>): boolean {
  return options.minDelayMs >= 0 && options.maxDelayMs >= options.minDelayMs;
}

function hasValidJitterRatio(jitterRatio: number): boolean {
  return jitterRatio >= 0 && jitterRatio <= 1;
}

function readRandomValue(random: SyncRandom): number {
  const randomValue = random();
  if (randomValue < 0 || randomValue > 1 || !Number.isFinite(randomValue)) {
    throw new RangeError("random must return a finite value from zero through one");
  }
  return randomValue;
}

function jitteredDelay(attempt: number, randomValue: number, options: Required<SyncBackoffOptions>): number {
  const exponential = Math.min(options.maxDelayMs, options.minDelayMs * 2 ** (attempt - 1));
  const multiplier = 1 - options.jitterRatio + randomValue * options.jitterRatio * 2;
  return Math.min(options.maxDelayMs, Math.round(exponential * multiplier));
}
