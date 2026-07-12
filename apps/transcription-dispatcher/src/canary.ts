import { ConfigError } from "./errors.js";

export interface CanaryObservation {
  schemaVersion: string;
  provider: "deepinfra" | "cloudflare";
  model: string;
  versionContract: string;
  executionIdentity?: string;
}

export interface CanaryExpectation {
  provider: CanaryObservation["provider"];
  model: string;
  versionContract: string;
  executionIdentity?: string;
}

export interface CanaryResult {
  ok: boolean;
  disablePrimary: boolean;
  reason: "ok" | "schema_drift" | "identity_drift" | "probe_failure";
}

export async function runNoContentCanary(input: { probe: () => Promise<CanaryObservation>; expected: CanaryExpectation }): Promise<CanaryResult> {
  try {
    const observation = await input.probe();
    if (observation.schemaVersion !== "transcript.v1") return { ok: false, disablePrimary: true, reason: "schema_drift" };
    if (observation.provider !== input.expected.provider || observation.model !== input.expected.model || observation.versionContract !== input.expected.versionContract || (input.expected.executionIdentity !== undefined && observation.executionIdentity !== input.expected.executionIdentity)) {
      return { ok: false, disablePrimary: true, reason: "identity_drift" };
    }
    return { ok: true, disablePrimary: false, reason: "ok" };
  } catch {
    return { ok: false, disablePrimary: true, reason: "probe_failure" };
  }
}

export function createNoContentCanaryHandler(input: { probe: () => Promise<CanaryObservation>; expected: CanaryExpectation }): () => Promise<CanaryResult> {
  return () => runNoContentCanary(input);
}

export function assertCanaryIsContentFree(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("canary result is invalid");
  const keys = Object.keys(value as object);
  if (keys.some((key) => /text|audio|name|url|token|object|content/i.test(key))) throw new ConfigError("canary may not retain content");
}
