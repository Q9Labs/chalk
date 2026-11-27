import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiveStallRecovery } from "./receive-stall";
import { LONG_PULL_DEFERRAL_MS } from "./sfu-limits";
import { RemotePullScheduler, retryableRemotePull } from "./remote-pull-scheduler";
import { SFUError, type SFUPublication } from "./types";

const publication: SFUPublication = { participantId: "remote", source: "microphone", publicationId: "pub" };
const desired = new Map([["remote:microphone", publication]]);
const timeout = new SFUError("Timed out waiting for the Chalk SFU peer connection", "media_failed", { iceConnectionState: "checking" });

describe("remote pull retries after a peer-connection timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("stays retryable even when the timeout carries ICE state for user-facing classification", () => {
    expect(retryableRemotePull(timeout)).toBe(true);
  });

  it("is deferred finitely rather than removed from scheduling", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const scheduler = new RemotePullScheduler();
    scheduler.defer([publication], timeout);
    const receiveProgress = new ReceiveStallRecovery();
    expect(scheduler.pending(desired, new Map(), receiveProgress, false)).toEqual([]);
    vi.setSystemTime(LONG_PULL_DEFERRAL_MS);
    expect(scheduler.pending(desired, new Map(), receiveProgress, false)).toEqual([publication]);
  });
});
