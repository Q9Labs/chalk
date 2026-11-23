import type { ScreenAnnotationPoint, ScreenAnnotationPresence } from "@q9labsai/chalk-client";

export const LASER_TRAIL_MS = 380;
const MAX_TRAIL_SAMPLES = 16;
type LaserTrail = { readonly layerId: string; readonly fence: number; readonly samples: readonly AnnotationLaserSample[] };

export type AnnotationLaserSample = { readonly point: ScreenAnnotationPoint; readonly atMs: number };
export type AnnotationPresence = Pick<ScreenAnnotationPresence, "author" | "cursor" | "draft" | "server_at_ms" | "expires_at_ms"> & {
  readonly laserTrail?: readonly AnnotationLaserSample[];
};

/** Feed complete current snapshots, not deltas. Use one tracker per overlay. */
export function createAnnotationPresenceTracker() {
  const trails = new Map<string, LaserTrail>();

  return {
    update(samples: readonly ScreenAnnotationPresence[], nowMs: number): readonly AnnotationPresence[] {
      const active = new Set<string>();
      const presence: AnnotationPresence[] = [];
      for (const sample of samples) {
        if (sample.expires_at_ms <= nowMs) continue;
        const id = sample.author.participant_id;
        if (sample.cursor?.tool !== "pointer") {
          presence.push(sample);
          continue;
        }
        active.add(id);
        const laserTrail = advanceLaserTrail(trails.get(id), sample, sample.cursor.point, nowMs);
        trails.set(id, { layerId: sample.layer_id, fence: sample.fence, samples: laserTrail });
        presence.push({ ...sample, laserTrail });
      }
      for (const id of trails.keys()) {
        if (!active.has(id)) trails.delete(id);
      }
      return presence;
    },
    clear(): void {
      trails.clear();
    },
  };
}

function advanceLaserTrail(previous: LaserTrail | undefined, sample: ScreenAnnotationPresence, point: ScreenAnnotationPoint, nowMs: number): readonly AnnotationLaserSample[] {
  const cutoff = nowMs - LASER_TRAIL_MS;
  const sameLayer = previous?.layerId === sample.layer_id && previous.fence === sample.fence;
  const recent = sameLayer ? previous.samples.filter((sample) => sample.atMs > cutoff) : [];
  const atMs = sample.server_at_ms;
  if (atMs > cutoff && isNewLaserPoint(recent.at(-1), point, atMs)) recent.push({ point, atMs });
  return recent.slice(-MAX_TRAIL_SAMPLES);
}

// A replay of the same snapshot must not move the tail forward.
function isNewLaserPoint(last: AnnotationLaserSample | undefined, point: ScreenAnnotationPoint, atMs: number): boolean {
  return !last || atMs > last.atMs || (atMs === last.atMs && (point.x !== last.point.x || point.y !== last.point.y));
}
