import { describe, expect, it } from "vitest";
import type { CallStatsSample } from "./call-stats";
import { createLinkTracker, enterTier, holdTier, linkWindow, LINK_MIN_SHOWN_MS } from "./link-quality";

const sample = (fields: Partial<CallStatsSample> = {}): CallStatsSample => ({ elapsed_ms: 10_000, window_ms: 10_000, connection_type: "udp", ...fields });
const tier = (fields: Partial<CallStatsSample>, syncDegraded = false) => enterTier(linkWindow(sample(fields), syncDegraded));
const held = (fields: Partial<CallStatsSample>) => holdTier(linkWindow(sample(fields), false));

function rig() {
  let time = 0;
  const tracker = createLinkTracker({ now: () => time });
  /** One 10 s window closes: time moves on and the tracker sees a new sample. */
  const window = (fields: Partial<CallStatsSample>, syncDegraded = false) => {
    time += 10_000;
    return tracker.observe(sample(fields), syncDegraded);
  };
  return { tracker, window, wait: (ms: number) => void (time += ms) };
}

describe("tier mapping", () => {
  it("rates a window by loss, round trip, frozen video and sync health", () => {
    expect(tier({ rtt_ms: 120, recv_loss_pct: 1 })).toBe("good");
    expect(tier({ recv_loss_pct: 5 })).toBe("weak");
    expect(tier({ rtt_ms: 400 })).toBe("weak");
    expect(tier({}, true)).toBe("weak");
    expect(tier({ send_loss_pct: 15 })).toBe("poor");
    expect(tier({ rtt_ms: 800 })).toBe("poor");
    expect(tier({ freeze_ms: 3_000 })).toBe("poor");
    expect(tier({ freeze_ms: 2_999 })).toBe("good");
  });

  it("counts a window that measured nothing as clean", () => {
    expect(tier({})).toBe("good");
  });

  it("uses the lower exit lines to leave a tier", () => {
    expect(held({ recv_loss_pct: 4, rtt_ms: 350 })).toBe("weak");
    expect(held({ recv_loss_pct: 1.9, rtt_ms: 299 })).toBe("good");
    expect(held({ recv_loss_pct: 8 })).toBe("poor");
    expect(held({ recv_loss_pct: 7.9, rtt_ms: 599 })).toBe("weak");
  });
});

describe("hysteresis", () => {
  it("never shows one bad window", () => {
    const { window } = rig();
    expect(window({ recv_loss_pct: 9 }).tier).toBe("good");
    expect(window({ recv_loss_pct: 0 }).tier).toBe("good");
    expect(window({ recv_loss_pct: 9 }).tier).toBe("good");
  });

  it("shows weak after 2 bad windows in a row, with the cause", () => {
    const { window } = rig();
    window({ recv_loss_pct: 9 });
    expect(window({ recv_loss_pct: 9 })).toEqual({ tier: "weak", reason: "loss" });
  });

  it("names latency, and sync when nothing else is wrong", () => {
    const slow = rig();
    slow.window({ rtt_ms: 500 });
    expect(slow.window({ rtt_ms: 500 })).toEqual({ tier: "weak", reason: "latency" });
    const sync = rig();
    sync.window({}, true);
    expect(sync.window({}, true)).toEqual({ tier: "weak", reason: "sync" });
  });

  it("clears after 3 clean windows in a row once it has shown 30 s", () => {
    const { window } = rig();
    window({ recv_loss_pct: 9 });
    window({ recv_loss_pct: 9 });
    expect(window({}).tier).toBe("weak");
    expect(window({}).tier).toBe("weak");
    expect(window({}).tier).toBe("good");
  });

  it("restarts the clean count when a window sits between the exit line and the enter line", () => {
    const { window } = rig();
    window({ recv_loss_pct: 9 });
    window({ recv_loss_pct: 9 });
    window({});
    window({});
    expect(window({ recv_loss_pct: 3 }).tier).toBe("weak");
    expect(window({}).tier).toBe("weak");
    expect(window({}).tier).toBe("weak");
    expect(window({}).tier).toBe("good");
  });

  it("keeps a tier on screen at least 30 s even when clean windows arrive fast", () => {
    let time = 0;
    const tracker = createLinkTracker({ now: () => time });
    const feed = (fields: Partial<CallStatsSample>, advance: number) => {
      time += advance;
      return tracker.observe(sample(fields), false);
    };
    feed({ recv_loss_pct: 9 }, 1_000);
    feed({ recv_loss_pct: 9 }, 1_000);
    feed({}, 1_000);
    feed({}, 1_000);
    expect(feed({}, 1_000).tier).toBe("weak");
    expect(feed({}, LINK_MIN_SHOWN_MS).tier).toBe("good");
  });

  it("offers very poor above weak, and steps down to weak before good", () => {
    const { window } = rig();
    window({ recv_loss_pct: 20 });
    expect(window({ recv_loss_pct: 20 }).tier).toBe("poor");
    window({ recv_loss_pct: 6 });
    window({ recv_loss_pct: 6 });
    expect(window({ recv_loss_pct: 6 }).tier).toBe("weak");
    window({});
    window({});
    expect(window({}).tier).toBe("good");
  });

  it("moves up to poor after 2 windows past the poor line, even from weak", () => {
    const { window } = rig();
    window({ recv_loss_pct: 6 });
    window({ recv_loss_pct: 6 });
    expect(window({ rtt_ms: 900 }).tier).toBe("weak");
    expect(window({ rtt_ms: 900 }).tier).toBe("poor");
  });

  it("holds the lower of two rising windows", () => {
    const { window } = rig();
    window({ recv_loss_pct: 20 });
    expect(window({ recv_loss_pct: 6 }).tier).toBe("weak");
  });

  it("ignores the same window seen twice", () => {
    const { tracker } = rig();
    const bad = sample({ recv_loss_pct: 20 });
    tracker.observe(bad, false);
    expect(tracker.observe(bad, false).tier).toBe("good");
  });

  it("starts over on a new peer connection and does not count the old window again", () => {
    const { tracker, window } = rig();
    window({ recv_loss_pct: 9 });
    window({ recv_loss_pct: 9 });
    expect(tracker.current().tier).toBe("weak");
    const old = sample({ recv_loss_pct: 9 });
    tracker.reset(old);
    expect(tracker.current().tier).toBe("good");
    expect(tracker.observe(old, false).tier).toBe("good");
    window({ recv_loss_pct: 9 });
    expect(tracker.current().tier).toBe("good");
    expect(window({ recv_loss_pct: 9 }).tier).toBe("weak");
  });
});
