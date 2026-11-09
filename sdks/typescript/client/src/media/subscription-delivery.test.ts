import { describe, expect, it } from "vitest";
import { LAYER_REREAD_MS, PAUSED_REREAD_MS, SUBSCRIPTION_READ_AFTER_QUIET_MS, SubscriptionDelivery, type DeliveredVideo } from "./subscription-delivery";
import type { SFUSubscriptionState } from "./types";

const video: DeliveredVideo = { publicationId: "pub-cam", trackId: "track-1", mid: "3", sessionId: "publisher", trackName: "camera" };
const state = (value: SFUSubscriptionState["state"], revision: number, extra: Partial<SFUSubscriptionState> = {}): SFUSubscriptionState => ({ mid: "3", sessionId: "publisher", trackName: "camera", state: value, revision, requestedRid: "h", ...extra });
const flowing = new Set([video.publicationId]);
const quiet = new Set<string>();

function read(delivery: SubscriptionDelivery, now: number, states: readonly SFUSubscriptionState[]): readonly string[] {
  return delivery.applied(delivery.begin(now), states);
}

describe("subscription delivery", () => {
  it("holds a quiet video until a read that started after the quiet says the SFU still sends it", () => {
    const delivery = new SubscriptionDelivery();
    delivery.observe(0, [video], flowing);
    read(delivery, 0, [state("active", 1, { effectiveRid: "h" })]);
    delivery.observe(1000, [video], quiet);
    expect(delivery.needsRead(1000 + SUBSCRIPTION_READ_AFTER_QUIET_MS - 1)).toBe(false);
    expect(delivery.needsRead(1000 + SUBSCRIPTION_READ_AFTER_QUIET_MS)).toBe(true);
    expect(delivery.held(video.publicationId, 3000)).toBe(true);
    read(delivery, 3000, [state("active", 1, { effectiveRid: "h" })]);
    expect(delivery.held(video.publicationId, 4000)).toBe(false);
  });

  it("keeps a congestion pause held and shown until the SFU resumes it, and reports the resume", () => {
    const delivery = new SubscriptionDelivery();
    delivery.observe(0, [video], quiet);
    read(delivery, 2000, [state("paused", 2, { reason: "congestion" })]);
    expect(delivery.deliveries).toEqual([{ publicationId: video.publicationId, state: "paused_for_network" }]);
    expect(delivery.pausedForNetwork).toBe(1);
    for (let now = 3000; now < 60_000; now += 1000) delivery.observe(now, [video], quiet);
    expect(delivery.held(video.publicationId, 60_000)).toBe(true);
    expect(delivery.needsRead(2000 + PAUSED_REREAD_MS)).toBe(true);
    expect(read(delivery, 60_000, [state("active", 3, { effectiveRid: "l" })])).toEqual([video.publicationId]);
    expect(delivery.deliveries).toEqual([{ publicationId: video.publicationId, state: "flowing", layer: "l" }]);
  });

  it("lets packets end a pause and never lets an older revision bring it back", () => {
    const delivery = new SubscriptionDelivery();
    delivery.observe(0, [video], quiet);
    read(delivery, 2000, [state("paused", 5, { reason: "congestion" })]);
    delivery.observe(3000, [video], flowing);
    expect(delivery.deliveries).toMatchObject([{ state: "flowing" }]);
    read(delivery, 4000, [state("paused", 4, { reason: "congestion" })]);
    expect(delivery.deliveries).toMatchObject([{ state: "flowing" }]);
    read(delivery, 5000, [state("paused", 5, { reason: "congestion" })]);
    expect(delivery.deliveries).toMatchObject([{ state: "paused_for_network" }]);
  });

  it("does not show a viewer pause as a network pause", () => {
    const delivery = new SubscriptionDelivery();
    delivery.observe(0, [video], quiet);
    read(delivery, 0, [state("paused", 1, { reason: "viewer" })]);
    expect(delivery.deliveries).toEqual([{ publicationId: video.publicationId, state: "flowing" }]);
    expect(delivery.pausedForNetwork).toBe(0);
  });

  it("releases quiet videos to stall recovery after a failed read and waits before the next", () => {
    const delivery = new SubscriptionDelivery();
    delivery.observe(0, [video], quiet);
    expect(delivery.held(video.publicationId, 2000)).toBe(true);
    const startedAt = delivery.begin(2000);
    expect(delivery.needsRead(2500)).toBe(false);
    delivery.failed(startedAt, 2500);
    expect(delivery.held(video.publicationId, 3000)).toBe(false);
    expect(delivery.needsRead(2500 + PAUSED_REREAD_MS - 1)).toBe(false);
  });

  it("starts a repulled receiver from a new revision and forgets videos no longer received", () => {
    const delivery = new SubscriptionDelivery();
    delivery.observe(0, [video], flowing);
    read(delivery, 0, [state("active", 9)]);
    const repulled = { ...video, trackId: "track-2", mid: "4" };
    delivery.observe(1000, [repulled], flowing);
    read(delivery, 1000, [state("paused", 1, { mid: "4", reason: "congestion" })]);
    expect(delivery.deliveries).toMatchObject([{ state: "paused_for_network" }]);
    delivery.observe(2000, [], quiet);
    expect(delivery.deliveries).toEqual([]);
    expect(delivery.needsRead(2000 + LAYER_REREAD_MS)).toBe(false);
  });

  it("keeps the same frozen array while nothing visible changes", () => {
    const delivery = new SubscriptionDelivery();
    delivery.observe(0, [video], flowing);
    read(delivery, 0, [state("active", 1, { effectiveRid: "h" })]);
    const first = delivery.deliveries;
    delivery.observe(1000, [video], flowing);
    read(delivery, LAYER_REREAD_MS, [state("active", 1, { effectiveRid: "h" })]);
    expect(delivery.deliveries).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
