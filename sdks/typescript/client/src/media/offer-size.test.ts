import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedOfferAddition, measureOffer, shouldReplaceForOfferSize } from "./offer-size";

// A Chromium offer (identifiers removed) with a live audio and video send, one live audio receive, and one closed audio and one closed video receive.
export const chromiumOffer = readFileSync(new URL("./fixtures/chromium-offer-with-closed-sections.sdp", import.meta.url), "utf8");

const sections = chromiumOffer.split(/(?=^m=)/m).slice(1);
const closed = sections.filter((section) => /^m=\w+ 0 /.test(section));

// A Chromium offer whose audio and video receivers were parked inactive, as the SDK parks a closed receiver: they keep their full size.
const parkedOffer = readFileSync(new URL("./fixtures/chromium-offer-with-parked-receivers.sdp", import.meta.url), "utf8");

describe("offer size", () => {
  it("budgets audio and video sections for every track in the next operation", () => {
    expect(expectedOfferAddition([{ source: "microphone" }, { source: "screen_audio" }, { source: "camera" }, { source: "screen" }])).toBe(12_800);
    expect(expectedOfferAddition([])).toBe(0);
  });

  it("counts parked receivers as reclaimable, because Chromium keeps them at full size", () => {
    const parked = parkedOffer.split(/(?=^m=)/m).slice(1);
    expect(parked.map((section) => /^m=(\w+)/.exec(section)?.[1])).toEqual(["audio", "video"]);
    expect(measureOffer(parkedOffer).reclaimableBytes).toBe(parked.reduce((total, section) => total + section.length, 0));
    expect(parked.every((section) => !/^m=\w+ 0 /.test(section))).toBe(true);
  });

  it("counts the closed sections of a real Chromium offer", () => {
    expect(closed.map((section) => /^m=(\w+)/.exec(section)?.[1])).toEqual(["audio", "video"]);
    expect(measureOffer(chromiumOffer).reclaimableBytes).toBe(closed.reduce((total, section) => total + section.length, 0));
    // A closed video section costs several audio sections, so a count of sections would not bound the offer.
    expect(closed[1]!.length).toBeGreaterThan(3 * closed[0]!.length);
  });

  it("replaces only when closed sections are what holds the offer over the trigger", () => {
    const [, , closedAudio, closedVideo] = sections;
    const live = sections[0]! + sections[1]!;
    const withClosed = (audio: number, video: number) => live + closedAudio!.repeat(audio) + closedVideo!.repeat(video);
    expect(shouldReplaceForOfferSize(measureOffer(chromiumOffer))).toBe(false);
    expect(shouldReplaceForOfferSize(measureOffer(withClosed(180, 0)))).toBe(true);
    expect(shouldReplaceForOfferSize(measureOffer(withClosed(0, 40)))).toBe(true);
  });

  it("replaces before the next batch overshoots the request budget, even below the soft trigger", () => {
    expect(shouldReplaceForOfferSize({ bytes: 159 * 1024, reclaimableBytes: 4 * 1024 }, { additionalBytes: 4 * 5200 })).toBe(true);
    expect(shouldReplaceForOfferSize({ bytes: 175 * 1024, reclaimableBytes: 2400 }, { additionalBytes: 2400 })).toBe(true);
    expect(shouldReplaceForOfferSize({ bytes: 175 * 1024, reclaimableBytes: 1200 }, { additionalBytes: 2400 })).toBe(false);
  });

  it("never lets the cooldown hold back a projected overshoot", () => {
    expect(shouldReplaceForOfferSize({ bytes: 175 * 1024, reclaimableBytes: 8 * 1024 }, { additionalBytes: 5200, coolingDown: true })).toBe(true);
  });

  it("keeps a ten-camera-guest live offer and the next guest on the same connection", () => {
    expect(shouldReplaceForOfferSize({ bytes: 75_000, reclaimableBytes: 0 })).toBe(false);
    expect(shouldReplaceForOfferSize({ bytes: 75_000, reclaimableBytes: 0 }, { additionalBytes: 7500 })).toBe(false);
  });

  it("does not replace live sections even when the projected request is too large", () => {
    expect(shouldReplaceForOfferSize({ bytes: 240 * 1024, reclaimableBytes: 0 }, { additionalBytes: 17_000 })).toBe(false);
    expect(shouldReplaceForOfferSize({ bytes: 240 * 1024, reclaimableBytes: 0 }, { additionalBytes: 17_000, coolingDown: true })).toBe(false);
  });

  it("preserves the soft trigger, reclaimable threshold and cooldown below the request budget", () => {
    expect(shouldReplaceForOfferSize({ bytes: 158 * 1024, reclaimableBytes: 20 * 1024 }, { additionalBytes: 5200 })).toBe(false);
    expect(shouldReplaceForOfferSize({ bytes: 160 * 1024, reclaimableBytes: 8 * 1024 }, { additionalBytes: 1200 })).toBe(true);
    expect(shouldReplaceForOfferSize({ bytes: 160 * 1024, reclaimableBytes: 8 * 1024 }, { additionalBytes: 1200, coolingDown: true })).toBe(false);
    expect(shouldReplaceForOfferSize({ bytes: 176 * 1024 - 1200, reclaimableBytes: 4 * 1024 }, { additionalBytes: 1200 })).toBe(false);
  });

  it("decides at the boundaries of the request budget and near-cap tiers", () => {
    const KiB = 1024;
    const replaces = (bytes: number, reclaimableBytes: number) => shouldReplaceForOfferSize({ bytes: bytes * KiB, reclaimableBytes: reclaimableBytes * KiB });
    // Live sections alone never replace, whatever their size: a fresh connection keeps them.
    expect(replaces(180, 0)).toBe(false);
    expect(replaces(248, 0)).toBe(false);
    // The soft path still needs 8 KiB, and the request-budget path needs 4 KiB when no sections are added.
    expect(replaces(180, 2)).toBe(false);
    expect(replaces(160, 8)).toBe(true);
    expect(replaces(160, 20)).toBe(true);
    // Above the request budget or near the node's cap, 4 KiB of closed sections is worth reclaiming, and less is not.
    expect(replaces(176, 7)).toBe(false);
    expect(replaces(220, 7)).toBe(true);
    expect(replaces(248, 7)).toBe(true);
    expect(replaces(264, 4)).toBe(true);
    expect(replaces(240, 3)).toBe(false);
    // Under the trigger nothing replaces.
    expect(replaces(159, 20)).toBe(false);
  });
});
