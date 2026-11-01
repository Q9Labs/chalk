import { expect, vi } from "vitest";
import { LinkWatch, type PageLifecycle } from "../../src/sync/link-watch";
import { createConvergenceScenario, enterRecovery } from "./media-convergence";

export const sources = ["microphone", "camera"] as const;
export type Source = (typeof sources)[number];
export type Scenario = ReturnType<typeof createConvergenceScenario>;
export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
export const live = (platform: Scenario["platform"]) => ({ ...platform.sync.getSnapshot(), connection: { phase: "live" as const } });

export const mediaPhase = (platform: Scenario["platform"], phase: "recovering" | "live") =>
  platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase, peerConnectionState: phase === "live" ? "connected" : "connecting", iceConnectionState: phase === "live" ? "connected" : "checking" }, failure: null });

// The media plane publishes after recovery and Sync lists it: a source the recovery kept wanted-on confirms.
export function confirmPublication(platform: Scenario["platform"], track: MediaStreamTrack, source: Source): void {
  const publication = { participantId: "participant-1", source, enabled: true, publicationId: "publication-2" };
  platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, track }] });
  platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 1, items: [publication] } });
}

export const hostStop = (source: Source, offRevision: number) => ({ participantId: "participant-1", source, enabled: false, publicationId: null, offReason: "host" as const, offRevision });

export function recoveryScenario(source: Source, overrides: Parameters<typeof createConvergenceScenario>[1] = {}) {
  const setLocalSourceIntent = vi.fn(async () => {});
  const closeForcedLocalPublication = vi.fn(async () => undefined);
  const scenario = createConvergenceScenario(source, { ...overrides, media: { setLocalSourceIntent, closeForcedLocalPublication, ...overrides.media } });
  return { ...scenario, setLocalSourceIntent, closeForcedLocalPublication };
}

/** The browser document as the Page Lifecycle API shows it: `freeze` and `resume` events, a visibility state and `wasDiscarded`. */
export class PageDouble implements PageLifecycle {
  visibilityState: "visible" | "hidden" = "visible";
  wasDiscarded = false;
  readonly #listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, (this.#listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  dispatch(type: "freeze" | "resume"): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
  listenerCount(): number {
    return [...this.#listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

/** A wall clock, a monotonic clock and a page the test moves by hand, behind the real `LinkWatch`. */
export function linkRig() {
  const clocks = { wall: 1_800_000_000_000, mono: 60_000 };
  const page = new PageDouble();
  const watch = new LinkWatch({ wall: () => clocks.wall, mono: () => clocks.mono }, page);
  watch.open();
  return {
    watch,
    page,
    /** Whether the connected Sync advertised `media_off_reason`. */
    extension: true,
    /** Both clocks advance by the same time. */
    elapse: (ms: number) => {
      clocks.wall += ms;
      clocks.mono += ms;
    },
    /** The clocks advance by different amounts: a clock step, or a suspend that stops the monotonic clock. */
    advance: ({ wall, mono }: { readonly wall: number; readonly mono: number }) => {
      clocks.wall += wall;
      clocks.mono += mono;
    },
    /** The page sends a ping. False when the oldest ping has gone unanswered so long that the client replaces the socket. */
    ping: () => watch.pinged(),
    /** A pong arrives from Sync, answering the oldest ping in flight. */
    pong: () => watch.ponged(),
    /** A ping and its pong 50 ms later, the way a healthy link answers. */
    contact: () => {
      watch.pinged();
      clocks.wall += 50;
      clocks.mono += 50;
      watch.ponged();
    },
    /** A healthy ping every `every` ms for `ms`: 20 s on a healthy page, about 60 s in a hidden tab with intensively throttled timers. */
    heartbeats: (ms: number, every = 20_000) => {
      for (let elapsed = 0; elapsed < ms; elapsed += every) {
        watch.pinged();
        clocks.wall += 50;
        clocks.mono += 50;
        watch.ponged();
        clocks.wall += every - 50;
        clocks.mono += every - 50;
      }
    },
  };
}

type DropOptions = {
  /** Time passes between the loss and the recovered snapshot. */
  readonly drop?: (rig: ReturnType<typeof linkRig>) => void;
  /** Time passes after the last proof of contact and before the loss. */
  readonly beforeLoss?: (rig: ReturnType<typeof linkRig>) => void;
  readonly items?: readonly object[];
  readonly duringDrop?: (setEnabled: Scenario["setEnabled"]) => Promise<unknown>;
  readonly extension?: boolean;
  /** Runs while Sync is down, before the recovered snapshot: a replayed stop event arrives here. */
  readonly beforeRecovered?: (platform: Scenario["platform"]) => void;
};

/** The source is on, Sync loses the connection, and the recovered snapshot arrives after `drop`. */
export async function dropAndRecover(source: Source, { drop = (rig) => rig.elapse(1_000), beforeLoss = () => undefined, items = [], duringDrop = async () => undefined, extension = true, beforeRecovered }: DropOptions = {}) {
  const rig = linkRig();
  rig.extension = extension;
  const scenario = recoveryScenario(source, { sync: { link: rig.watch, offReasonNegotiated: () => rig.extension } });
  const { client, platform, setEnabled } = scenario;
  const finish = () => {
    client.dispose();
    rig.watch.close();
  };
  try {
    await client.join({ microphone: false, camera: false });
    await setEnabled(true);
    rig.contact();
    beforeLoss(rig);
    await enterRecovery({ platform, client });
    const user = duringDrop(setEnabled);
    drop(rig);
    beforeRecovered?.(platform);
    platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
    await user;
    await tick(20);
  } catch (cause) {
    finish();
    throw cause;
  }
  return { ...scenario, rig, finish };
}
