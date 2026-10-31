import { describe, expect, it } from "vitest";
import { setVideoRenderSize } from "./video-render-size";
import { ViewerLayerPolicy, ViewerLayerSelector, ViewerStatsReader, type ViewerLayerSample } from "./viewer-layer";

const good: ViewerLayerSample = { lossFraction: 0, framesPerSecond: 30, newFreezes: 0, freezeSeconds: 0, tileHeight: undefined };
const severeFreeze: ViewerLayerSample = { ...good, newFreezes: 1, freezeSeconds: 2 };
const lossy: ViewerLayerSample = { ...good, lossFraction: 0.08 };

function run(policy: ViewerLayerPolicy, sample: ViewerLayerSample, count: number): void {
  for (let i = 0; i < count; i++) policy.sample(sample);
}

describe("viewer layer policy", () => {
  it("keeps h while the link is healthy", () => {
    const policy = new ViewerLayerPolicy();
    run(policy, good, 100);
    expect(policy.layer).toBe("h");
  });

  it("drops to l after two consecutive lossy samples, not one", () => {
    const policy = new ViewerLayerPolicy();
    expect(policy.sample(lossy)).toBe("h");
    expect(policy.sample(good)).toBe("h");
    expect(policy.sample(lossy)).toBe("h");
    expect(policy.sample(lossy)).toBe("l");
  });

  it("treats one short freeze as a bad sample, not a reason to drop", () => {
    const policy = new ViewerLayerPolicy();
    expect(policy.sample({ ...good, newFreezes: 1, freezeSeconds: 0.3 })).toBe("h");
    expect(policy.sample({ ...good, newFreezes: 1, freezeSeconds: 0.3 })).toBe("l");
  });

  it("drops at once on a long freeze or severe loss", () => {
    expect(new ViewerLayerPolicy().sample(severeFreeze)).toBe("l");
    expect(new ViewerLayerPolicy().sample({ ...good, lossFraction: 0.2 })).toBe("l");
  });

  it("treats frames that stop while packets arrive as a layer that is too heavy", () => {
    const policy = new ViewerLayerPolicy();
    run(policy, { ...good, lossFraction: 0.01, framesPerSecond: 3 }, 2);
    expect(policy.layer).toBe("l");
  });

  it("does not hold the viewer on l because the sender itself has a low frame rate", () => {
    const policy = new ViewerLayerPolicy();
    policy.sample(severeFreeze);
    run(policy, { ...good, framesPerSecond: 4 }, 2 + 15);
    expect(policy.layer).toBe("h");
  });

  it("keeps a sender-limited 4 fps camera on h after comparing both layers", () => {
    const policy = new ViewerLayerPolicy();
    const slow = { ...good, framesPerSecond: 4, tileHeight: 720 };
    run(policy, slow, 300);
    for (let i = 0; i < 300; i++) expect(policy.sample(slow)).toBe("h");
    expect(policy.sample(severeFreeze)).toBe("l");
  });

  it("still backs off when l improves a downlink-limited frame rate", () => {
    const policy = new ViewerLayerPolicy();
    const slow = { ...good, framesPerSecond: 4 };
    run(policy, slow, 2);
    run(policy, good, 2 + 15);
    expect(policy.layer).toBe("h");
    run(policy, slow, 2 + 2);
    expect(policy.layer).toBe("l");
    run(policy, good, 2 + 29);
    expect(policy.layer).toBe("l");
    expect(policy.sample(good)).toBe("h");
  });

  it("relearns congestion after the sender recovers or frame rate falls further", () => {
    for (const recovered of [false, true]) {
      const policy = new ViewerLayerPolicy();
      run(policy, { ...good, framesPerSecond: 4 }, 100);
      expect(policy.layer).toBe("h");
      if (recovered) run(policy, good, 3);
      run(policy, { ...good, framesPerSecond: recovered ? 4 : 1 }, 2);
      expect(policy.layer).toBe("l");
    }
  });

  it("ignores the samples that still describe the old layer after a switch", () => {
    const policy = new ViewerLayerPolicy();
    policy.sample(severeFreeze);
    // The two settle samples cannot count toward the rise.
    run(policy, good, 2 + 14);
    expect(policy.layer).toBe("l");
    expect(policy.sample(good)).toBe("h");
  });

  it("restarts the good run when a sample is bad or unknown", () => {
    const policy = new ViewerLayerPolicy();
    policy.sample(severeFreeze);
    run(policy, good, 2 + 10);
    policy.sample({ ...good, lossFraction: undefined });
    run(policy, good, 14);
    expect(policy.layer).toBe("l");
    expect(policy.sample(good)).toBe("h");
  });

  it("doubles the wait after a rise that fails soon, and resets it after a long stable stretch", () => {
    const policy = new ViewerLayerPolicy();
    policy.sample(severeFreeze);
    run(policy, good, 2 + 15);
    expect(policy.layer).toBe("h");
    run(policy, good, 2);
    policy.sample(severeFreeze);
    expect(policy.layer).toBe("l");
    run(policy, good, 2 + 29);
    expect(policy.layer).toBe("l");
    expect(policy.sample(good)).toBe("h");
    run(policy, good, 2 + 60);
    policy.sample(severeFreeze);
    run(policy, good, 2 + 14);
    expect(policy.layer).toBe("l");
    expect(policy.sample(good)).toBe("h");
  });

  it("uses l for a small tile and returns to h quickly when the tile grows", () => {
    const policy = new ViewerLayerPolicy();
    expect(policy.sample({ ...good, tileHeight: 270 })).toBe("l");
    run(policy, { ...good, tileHeight: 440 }, 10);
    expect(policy.layer).toBe("l");
    run(policy, { ...good, tileHeight: 720 }, 1 + 2);
    expect(policy.layer).toBe("h");
  });

  it("does not flap for a tile between the two limits", () => {
    const policy = new ViewerLayerPolicy();
    run(policy, { ...good, tileHeight: 440 }, 5);
    expect(policy.layer).toBe("h");
    policy.sample({ ...good, tileHeight: 300 });
    run(policy, { ...good, tileHeight: 440 }, 10);
    expect(policy.layer).toBe("l");
  });

  it("keeps h when the UI never reports a tile size", () => {
    const policy = new ViewerLayerPolicy();
    run(policy, good, 30);
    expect(policy.layer).toBe("h");
  });
});

type Row = Record<string, unknown>;
const inbound = (trackIdentifier: string, timestamp: number, over: Row = {}): Row => ({ type: "inbound-rtp", kind: "video", trackIdentifier, timestamp, packetsReceived: 0, packetsLost: 0, framesDecoded: 0, freezeCount: 0, totalFreezesDuration: 2 * Number(over.freezeCount ?? 0), ...over });

describe("viewer stats reader", () => {
  it("reports nothing until it has a baseline", () => {
    expect(new ViewerStatsReader().read([inbound("t", 1000)], "t")).toBeUndefined();
  });

  it("turns counters into loss, frame rate and new freezes", () => {
    const reader = new ViewerStatsReader();
    reader.read([inbound("t", 1000)], "t");
    const sample = reader.read([inbound("t", 2000, { packetsReceived: 90, packetsLost: 10, framesDecoded: 24, freezeCount: 1 })], "t");
    expect(sample).toEqual({ lossFraction: 0.1, framesPerSecond: 24, newFreezes: 1, freezeSeconds: 2 });
  });

  it("leaves loss unknown when no packet arrived or was lost", () => {
    const reader = new ViewerStatsReader();
    reader.read([inbound("t", 1000)], "t");
    expect(reader.read([inbound("t", 2000)], "t")?.lossFraction).toBeUndefined();
  });

  it("restarts from a new baseline when counters move backwards", () => {
    const reader = new ViewerStatsReader();
    reader.read([inbound("t", 1000, { packetsReceived: 500, framesDecoded: 300 })], "t");
    expect(reader.read([inbound("t", 2000, { packetsReceived: 5, framesDecoded: 2 })], "t")).toBeUndefined();
    expect(reader.read([inbound("t", 3000, { packetsReceived: 35, framesDecoded: 32 })], "t")?.framesPerSecond).toBe(30);
  });

  it("ignores rows for other tracks and audio", () => {
    const reader = new ViewerStatsReader();
    reader.read([inbound("other", 1000), inbound("t", 1000, { kind: "audio" })], "t");
    expect(reader.read([inbound("other", 2000, { framesDecoded: 30 })], "t")).toBeUndefined();
  });
});

describe("viewer layer selector", () => {
  const track = (id: string): MediaStreamTrack => Object.assign(Object.create(null), { id });
  const report = (rows: Row[]): RTCStatsReport => new Map(rows.map((row, index) => [String(index), row])) as unknown as RTCStatsReport;
  const camera = { publicationId: "session|cam", track: track("t") };

  it("reports a switch once the policy drops, and again after a failed switch only after the retry delay", () => {
    const selector = new ViewerLayerSelector();
    selector.sample(0, report([inbound("t", 1000)]), [camera]);
    const frozen = (timestamp: number, freezeCount: number) => report([inbound("t", timestamp, { packetsReceived: 100, framesDecoded: 30, freezeCount })]);
    const [change] = selector.sample(1000, frozen(2000, 1), [camera]);
    expect(change).toMatchObject({ publicationId: "session|cam", layer: "l" });
    selector.failed(change!, 1000);
    expect(selector.sample(2000, frozen(3000, 1), [camera])).toEqual([]);
    expect(selector.sample(6500, frozen(4000, 1), [camera])).toHaveLength(1);
  });

  it("waits longer after each rejected switch, up to a minute", () => {
    const selector = new ViewerLayerSelector();
    selector.sample(0, report([inbound("t", 0)]), [camera]);
    let now = 0;
    const tick = () => {
      now += 1000;
      return selector.sample(now, report([inbound("t", now, { packetsReceived: now / 10, framesDecoded: now / 40, freezeCount: now / 1000 })]), [camera]);
    };
    const nextChange = () => {
      let changes = tick();
      while (changes.length === 0) changes = tick();
      return changes[0]!;
    };
    selector.failed(nextChange(), now);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const failedAt = now;
      selector.failed(nextChange(), now);
      delays.push(now - failedAt);
    }
    expect(delays).toEqual([5000, 10_000, 20_000, 40_000, 60_000]);
  });

  it("stops asking once a switch is applied", () => {
    const selector = new ViewerLayerSelector();
    selector.sample(0, report([inbound("t", 1000)]), [camera]);
    const [change] = selector.sample(1000, report([inbound("t", 2000, { packetsReceived: 100, framesDecoded: 30, freezeCount: 1 })]), [camera]);
    selector.applied(change!);
    expect(selector.sample(2000, report([inbound("t", 3000, { packetsReceived: 200, framesDecoded: 60, freezeCount: 1 })]), [camera])).toEqual([]);
  });

  it("does not learn a sender limit from an unapplied lower layer", () => {
    const selector = new ViewerLayerSelector();
    const tick = (now: number) => selector.sample(now, report([inbound("t", now, { packetsReceived: now / 10, framesDecoded: now / 250 })]), [camera]);
    tick(0);
    tick(1000);
    const [change] = tick(2000);
    expect(change?.layer).toBe("l");
    for (let now = 3000; now <= 60_000; now += 1000) expect(tick(now)).toMatchObject([{ layer: "l" }]);
    selector.applied(change!);
    // The actual l now improves to 30 fps. That is downlink evidence, not a sender limit.
    for (let i = 1; i <= 17; i++) {
      const now = 60_000 + i * 1000;
      const changes = selector.sample(now, report([inbound("t", now, { packetsReceived: now / 10, framesDecoded: 240 + i * 30 })]), [camera]);
      if (i === 17) {
        expect(changes).toMatchObject([{ layer: "h" }]);
        selector.applied(changes[0]!);
      }
    }
    let changes;
    for (let i = 1; i <= 4; i++) {
      const now = 77_000 + i * 1000;
      changes = selector.sample(now, report([inbound("t", now, { packetsReceived: now / 10, framesDecoded: 750 + i * 4 })]), [camera]);
    }
    expect(changes).toMatchObject([{ layer: "l" }]);
  });

  it.each(["applied", "failed"] as const)("ignores a late %s result for a replaced receiver", (result) => {
    const selector = new ViewerLayerSelector();
    const original = { ...camera, track: track("t") };
    setVideoRenderSize(original.track, { width: 480, height: 270 });
    selector.sample(0, report([inbound("t", 0)]), [original]);
    const [old] = selector.sample(1000, report([inbound("t", 1000, { packetsReceived: 100, framesDecoded: 30 })]), [original]);
    const replacement = { ...original, track: track("new") };
    selector.sample(2000, report([inbound("new", 2000)]), [replacement]);
    selector[result](old!, 2000);
    expect(selector.sample(3000, report([inbound("new", 3000, { packetsReceived: 100, framesDecoded: 30 })]), [replacement])).toMatchObject([{ track: replacement.track, layer: "l" }]);
  });

  it("asks for l when the UI reports a small tile", () => {
    const selector = new ViewerLayerSelector();
    const small = track("small");
    setVideoRenderSize(small, { width: 480, height: 270 });
    const cameras = [{ publicationId: "session|small", track: small }];
    selector.sample(0, report([inbound("small", 1000)]), cameras);
    const changes = selector.sample(1000, report([inbound("small", 2000, { packetsReceived: 100, framesDecoded: 30 })]), cameras);
    expect(changes).toMatchObject([{ layer: "l" }]);
  });

  it("asks for l again when a stall re-pull replaces the receiver of the same publication", () => {
    const selector = new ViewerLayerSelector();
    const smallTrack = (id: string) => {
      const small = track(id);
      setVideoRenderSize(small, { width: 480, height: 270 });
      return small;
    };
    const pull = (id: string, now: number) => {
      const cameras = [{ publicationId: "session|small", track: smallTrack(id) }];
      selector.sample(now, report([inbound(id, now)]), cameras);
      return selector.sample(now + 1000, report([inbound(id, now + 1000, { packetsReceived: 100, framesDecoded: 30 })]), cameras);
    };
    const [first] = pull("first", 0);
    selector.applied(first!);
    // The re-pull keeps the publication ID, and the SFU starts the new subscription on h.
    expect(pull("second", 5000)).toMatchObject([{ layer: "l" }]);
  });
});
