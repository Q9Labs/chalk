import { deepEqual } from "alchemy/Diff";
import * as Redacted from "effect/Redacted";

const releaseEnvironmentKeys = new Set(["CHALK_RELEASE_ID", "CHALK_CONFIG_DIGEST", "CHALK_RELEASE_MANIFEST_DIGEST"]);
const releaseTagKeys = new Set(["chalk_release_id", "chalk_config_digest", "chalk_release_manifest_digest"]);
const plainValue = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return plainValue(Redacted.value(value));
  if (Array.isArray(value)) return value.map(plainValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainValue(child)]));
  return value;
};
const recordValue = (value: unknown): Record<string, unknown> => {
  const plain = plainValue(value);
  return plain !== null && typeof plain === "object" && !Array.isArray(plain) ? (plain as Record<string, unknown>) : {};
};
const sameExcept = (before: Record<string, unknown>, after: Record<string, unknown>, controlled: ReadonlySet<string>) => {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!controlled.has(key) && !deepEqual(before[key], after[key])) return false;
  }
  return true;
};

/**
 * A release can interrupt between Lambda's separate configuration and code APIs.
 * The provider writes release identity tags first, so this shape is known: every
 * differing value is release metadata or the code digest, and the live tags name
 * a release target different from the persisted one. Retry either way reconciles
 * it; memory, role, networking and other manual drift remain release blockers.
 */
export function isRecoverableReleaseDrift(persisted: unknown, live: unknown): boolean {
  const before = recordValue(persisted);
  const current = recordValue(live);
  const beforeConfiguration = recordValue(before.configuration);
  const currentConfiguration = recordValue(current.configuration);
  if (!Object.keys(beforeConfiguration).length || !Object.keys(currentConfiguration).length) return false;
  const beforeTags = recordValue(beforeConfiguration.tags);
  const currentTags = recordValue(currentConfiguration.tags);
  if (!beforeTags.chalk_release_id || !currentTags.chalk_release_id || deepEqual(beforeTags.chalk_release_id, currentTags.chalk_release_id)) return false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
    if (key !== "codeSha256" && key !== "configuration" && !deepEqual(before[key], current[key])) return false;
  }
  for (const key of new Set([...Object.keys(beforeConfiguration), ...Object.keys(currentConfiguration)])) {
    if (key === "description") continue;
    if (key === "environment") {
      if (!sameExcept(recordValue(beforeConfiguration.environment), recordValue(currentConfiguration.environment), releaseEnvironmentKeys)) return false;
    } else if (key === "tags") {
      if (!sameExcept(beforeTags, currentTags, releaseTagKeys)) return false;
    } else if (!deepEqual(beforeConfiguration[key], currentConfiguration[key])) return false;
  }
  return true;
}
