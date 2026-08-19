import type { ChalkServerClient, Space } from "@q9labsai/chalk-client/server";

import { BrokerError } from "./contracts";
import type { LeaseRecord } from "./store";

const anonymousSpaceMediaPlane = "cf_sfu";
const canonicalID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function provisionAnonymousSpace(chalk: ChalkServerClient, lease: LeaseRecord, tenantId: string): Promise<string> {
  const durationSeconds = isolatedSpaceDurationSeconds(lease);
  const space = await chalk.spaces.create(
    {
      admissionPolicy: { mode: "open" },
      defaultEpisodeDurationSeconds: durationSeconds,
      lingerWindowSeconds: 0,
      maximumEpisodeDurationSeconds: durationSeconds,
      mediaPlane: anonymousSpaceMediaPlane,
      metadata: { retention: "archive-on-lease-end", source: "chalkmeet.com/open-space" },
      name: "Space",
      slug: `open-${lease.logId}`,
    },
    { idempotencyKey: `space-create-${lease.logId}` },
  );
  requireExpectedSpace(space, tenantId, durationSeconds);
  return space.id;
}

export function isolatedSpaceDurationSeconds(lease: LeaseRecord): number {
  const durationSeconds = (lease.expiresAt - lease.createdAt) / 1_000;
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) throw new BrokerError(503, "The Space lease duration is invalid.");
  return durationSeconds;
}

export function leaseSpaceId(lease: LeaseRecord, legacySpaceId: string): string {
  if (lease.spaceId) return lease.spaceId;
  if (lease.spaceOrigin === "legacy" && legacySpaceId.trim()) return legacySpaceId;
  throw new BrokerError(503, "The Space is not ready.");
}

function requireExpectedSpace(space: Space, tenantId: string, durationSeconds: number): void {
  if (
    !canonicalID.test(space.id) ||
    space.tenant_id !== tenantId ||
    space.media_plane !== anonymousSpaceMediaPlane ||
    space.default_episode_duration_seconds !== durationSeconds ||
    space.maximum_episode_duration_seconds !== durationSeconds ||
    space.linger_window_seconds !== 0 ||
    !openAdmission(space.admission_policy)
  ) {
    throw new BrokerError(502, "The Space service returned an invalid Space.");
  }
}

function openAdmission(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "mode") === "open";
}
