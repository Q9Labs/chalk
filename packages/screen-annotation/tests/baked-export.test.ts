import { afterEach, describe, expect, it, vi } from "vitest";
import { BakedExportProof } from "../src/baked-export";

afterEach(() => vi.useRealTimers());

describe("saving ink baked into the video", () => {
  it("does not release a save on acceptance or when the local preview expires", async () => {
    vi.useFakeTimers();
    const ink = new BakedExportProof();
    ink.expect("new ink");
    const saved = vi.fn();
    const save = ink.wait().then((ready) => ready && saved());
    ink.accepted("new ink", 2);
    ink.reconcile(2, new Set(["new ink"]));
    await vi.advanceTimersByTimeAsync(1800);
    expect(saved).not.toHaveBeenCalled();
    ink.settle("new ink");
    await save;
    expect(saved).toHaveBeenCalledOnce();
  });

  it("declines the save without proof and accepts a later retry once there is proof", async () => {
    vi.useFakeTimers();
    const ink = new BakedExportProof();
    ink.expect("new ink");
    const save = ink.wait();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await save).toBe(false);
    ink.settle("new ink");
    expect(await ink.wait()).toBe(true);
  });

  it("only ignores a removed mark once the authoritative scene has passed the commit", async () => {
    const ink = new BakedExportProof();
    ink.expect("removed ink");
    ink.accepted("removed ink", 4);
    const save = ink.wait();
    ink.reconcile(3, new Set());
    ink.reconcile(4, new Set());
    expect(await save).toBe(true);
  });
});
