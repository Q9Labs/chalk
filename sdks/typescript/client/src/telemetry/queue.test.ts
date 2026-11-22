import { describe, expect, it } from "vitest";
import { DropList } from "./drops";
import { entryOf, EventQueue } from "./queue";
import type { TelemetryDraft } from "./types";

const entry = (seq: number, draft: TelemetryDraft, bytes = 100) =>
  entryOf({ ...draft, seq, event_id: `id-${seq}`, elapsed_ms: 0, ...(bytes > 100 ? { code: "internal_error" as const, dropped_seqs: Array.from({ length: Math.ceil(bytes / 18) }, (_, index) => ({ from: index, to: index + 1 })) } : {}) }, "subject");
const routine = { type: "platform_changed", platform_state: "visible" } as const;
const stats = { type: "call_stats", stats: { window_ms: 10_000 } } as const;
const p0 = { type: "call_ended", end_reason: "left" } as const;

describe("the queue's reservation", () => {
  it("lets routine events use half of the budget and never pushes a P0 event out for them", () => {
    const size = entry(1, routine, 300).bytes;
    const queue = new EventQueue(size * 3);
    queue.push(entry(0, p0, 300));
    const gone = Array.from({ length: 6 }, (_, index) => queue.push(entry(index + 1, routine, 300))).flat();
    expect(gone.map((evicted) => evicted.event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(queue.entries().map((held) => held.event.seq)).toEqual([0, 6]);
  });

  it("gives up stats windows before routine events, and folds two windows into the newer one", () => {
    const queue = new EventQueue(2 * (entry(0, routine, 200).bytes + entry(1, stats, 200).bytes + 40));
    queue.push(entry(0, routine, 200));
    queue.push(entry(1, stats, 200));
    const gone = queue.push(entry(2, stats, 200));
    expect(gone.map((evicted) => evicted.event.seq)).toEqual([1]);
    const held = queue.entries().map((kept) => kept.event);
    expect(held.map((event) => event.seq)).toEqual([0, 2]);
    expect(held[1]?.stats).toEqual({ window_ms: 20_000, gap: "dropped" });
  });

  it("gives up a P0 event only when no other event is held, and never a drop record", () => {
    const drop = entry(0, { type: "telemetry_dropped" }, 500);
    const queue = new EventQueue(drop.bytes + 2 * entry(1, p0, 300).bytes - 1);
    queue.push(drop);
    queue.push(entry(1, p0, 300));
    const gone = queue.push(entry(2, p0, 300));
    expect(gone.map((evicted) => evicted.event.seq)).toEqual([1]);
    expect(queue.entries().map((held) => held.event.seq)).toEqual([0, 2]);
  });
});

describe("the drop list", () => {
  it("merges neighbours into half-open ranges and names one reason at a time", () => {
    const drops = new DropList();
    for (const seq of [4, 2, 3, 9]) drops.add(seq, "queue_full");
    drops.add(1, "refused");
    expect(drops.take(64)).toEqual({
      reason: "queue_full",
      ranges: [
        { from: 2, to: 5 },
        { from: 9, to: 10 },
      ],
    });
    expect(drops.take(64)).toEqual({ reason: "refused", ranges: [{ from: 1, to: 2 }] });
    expect(drops.empty).toBe(true);
  });

  it("leaves ranges past 64 for the next record", () => {
    const drops = new DropList();
    for (let seq = 0; seq < 200; seq += 2) drops.add(seq, "queue_full");
    expect(drops.take(64)?.ranges).toHaveLength(64);
    expect(drops.take(64)?.ranges).toHaveLength(36);
  });
});
