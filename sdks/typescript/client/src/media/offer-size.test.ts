import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { measureOffer, shouldReplaceForOfferSize } from "./offer-size";

// A Chromium offer (identifiers removed) with a live audio and video send, one live audio receive, and one closed audio and one closed video receive.
export const chromiumOffer = readFileSync(new URL("./fixtures/chromium-offer-with-closed-sections.sdp", import.meta.url), "utf8");

const sections = chromiumOffer.split(/(?=^m=)/m).slice(1);
const closed = sections.filter((section) => /^m=\w+ 0 /.test(section));

// A Chromium offer whose audio and video receivers were parked inactive, as the SDK parks a closed receiver: they keep their full size.
const parkedOffer = readFileSync(new URL("./fixtures/chromium-offer-with-parked-receivers.sdp", import.meta.url), "utf8");

describe("offer size", () => {
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
    expect(shouldReplaceForOfferSize(measureOffer(withClosed(40, 0)))).toBe(true);
    expect(shouldReplaceForOfferSize(measureOffer(withClosed(0, 10)))).toBe(true);
  });

  it("decides at the boundaries of the two tiers", () => {
    const KiB = 1024;
    const replaces = (bytes: number, reclaimableBytes: number) => shouldReplaceForOfferSize({ bytes: bytes * KiB, reclaimableBytes: reclaimableBytes * KiB });
    // Live sections alone never replace, whatever their size: a fresh connection keeps them.
    expect(replaces(45, 0)).toBe(false);
    expect(replaces(62, 0)).toBe(false);
    // Below the ceiling, closed sections must hold at least 8 KiB, so a replacement cannot repeat itself.
    expect(replaces(45, 2)).toBe(false);
    expect(replaces(40, 8)).toBe(true);
    expect(replaces(40, 20)).toBe(true);
    // At the ceiling the next pull can pass the node's cap, so 4 KiB of closed sections is worth reclaiming, and less is not.
    expect(replaces(55, 7)).toBe(false);
    expect(replaces(62, 7)).toBe(true);
    expect(replaces(66, 4)).toBe(true);
    expect(replaces(60, 3)).toBe(false);
    // Under the trigger nothing replaces.
    expect(replaces(39, 20)).toBe(false);
  });
});
