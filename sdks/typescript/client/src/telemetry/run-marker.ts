import type { ObsRecord } from "../obs/kernel";

/** The fields a run marker keeps about a run: the dead-run evidence the next run reports. No pt_, ep_ or ten_ ever enters the body. */
export type RunMarker = {
  readonly cs: string;
  readonly phase: "boot" | "joining" | "live" | "reconnecting";
  readonly visibility?: "visible" | "hidden";
  readonly clean_exit?: "pagehide" | "call_ended";
  readonly last_elapsed_ms: number;
  readonly heap_used_mib?: number;
  readonly heap_limit_mib?: number;
  readonly written_ms: number;
};

export const MARKER_PREFIX = "chalk.run_marker.";
const MARKER_TTL_MS = 15_000;

type MarkerStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

const markerKey = (cs: string) => MARKER_PREFIX + cs;

/** Parses one stored marker body. Returns null for a body that is not a marker, so a corrupt key is skipped, never trusted. */
export function parseRunMarker(text: string | null): RunMarker | null {
  if (text === null) return null;
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null) return null;
    const marker = body as Record<string, unknown>;
    if (typeof marker.cs !== "string" || marker.cs.length === 0) return null;
    if (typeof marker.phase !== "string" || typeof marker.last_elapsed_ms !== "number" || typeof marker.written_ms !== "number") return null;
    return marker as RunMarker;
  } catch {
    return null;
  }
}

/** Lists every run marker the store holds, with its key. Throws when the store itself cannot be read. */
export function listRunMarkers(storage: MarkerStorage): readonly { readonly key: string; readonly marker: RunMarker }[] {
  const found: { key: string; marker: RunMarker }[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(MARKER_PREFIX)) continue;
    const marker = parseRunMarker(storage.getItem(key));
    if (marker !== null) found.push({ key, marker });
  }
  return found;
}

/** The one marker this run owns: written synchronously, so a kill leaves the last state behind. */
export type LiveRunMarker = {
  /** Re-writes the marker with `more` merged in, updating the liveness clock. */
  readonly update: (more: Partial<Omit<RunMarker, "cs" | "written_ms">>) => void;
  /** Writes the final state then removes the marker's need: a run that left cleanly is not reported dead. */
  readonly close: (cleanExit: "pagehide" | "call_ended") => void;
  /** Removes the marker without a clean-exit note. */
  readonly remove: () => void;
};

/** Opens this run's marker in the store, overwriting any stale one of the same cs. */
export function openRunMarker(storage: MarkerStorage, cs: string, wall: () => number, elapsed: () => number): LiveRunMarker {
  const key = markerKey(cs);
  let state: Omit<RunMarker, "cs" | "written_ms"> = { phase: "boot", last_elapsed_ms: Math.round(elapsed()) };
  const write = () => {
    try {
      storage.setItem(key, JSON.stringify({ ...state, cs, written_ms: wall() }));
    } catch {
      // A blocked store keeps no marker; the next run then has no marker to find, an honest gap.
    }
  };
  write();
  return {
    update: (more) => {
      state = { ...state, ...more, last_elapsed_ms: Math.round(elapsed()) };
      write();
    },
    close: (cleanExit) => {
      state = { ...state, clean_exit: cleanExit, last_elapsed_ms: Math.round(elapsed()) };
      write();
    },
    remove: () => {
      try {
        storage.removeItem(key);
      } catch {
        // Same as write: a blocked store is a gap, not an error.
      }
    },
  };
}

/** Whether a found marker still counts as young enough that the run may simply be starting up. */
export const markerIsYoung = (marker: RunMarker, wallNow: number) => wallNow - marker.written_ms < MARKER_TTL_MS;
