import { randomUUID } from "node:crypto";
import { check } from "./runtime.mjs";

const productionReleaseUrl = "https://chalkmeet.com/release.json";
const fullCommitSha = /^[0-9a-f]{40}$/;

export function requireExpectedProductionSha(environment = process.env) {
  const sha = environment.CHALK_PROOF_EXPECTED_PRODUCTION_SHA;
  check(typeof sha === "string" && fullCommitSha.test(sha), "CHALK_PROOF_EXPECTED_PRODUCTION_SHA must be a full lowercase 40-character commit SHA", "configuration");
  return sha;
}

export async function verifyExpectedProductionSha(expectedSha, fetchImpl = fetch) {
  const expected = requireExpectedProductionSha({ CHALK_PROOF_EXPECTED_PRODUCTION_SHA: expectedSha });
  const response = await fetchImpl(`${productionReleaseUrl}?leave_comparison=${randomUUID()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const identity = response.ok ? await response.json().catch(() => null) : null;
  check(response.ok && identity?.commit === expected, "Production release identity does not match CHALK_PROOF_EXPECTED_PRODUCTION_SHA", "evidence-assertion");
}
