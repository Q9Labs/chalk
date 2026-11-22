import { afterEach, describe, expect, it, vi } from "vitest";
import { BakedExportProof } from "../src/baked-export";
import { INK_PROOF_TIMEOUT_MS } from "../src/baked-stroke-proof";

afterEach(() => vi.useRealTimers());

describe("saving ink baked into the video", () => {
  it("saves with no proof at the shared deadline, not on server acceptance", async () => {
    vi.useFakeTimers();
    const ink = new BakedExportProof();
    ink.expect("new ink");
    let saved = false;
    const save = ink.wait([]).then(() => {
      saved = true;
    });
    ink.accepted("new ink", 2);
    ink.reconcile(2, new Set(["new ink"]));
    await vi.advanceTimersByTimeAsync(INK_PROOF_TIMEOUT_MS - 1);
    expect(saved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await save;
    expect(saved).toBe(true);
  });

  it("does not start the deadline again when a still-unproved kept mark is saved twice", async () => {
    vi.useFakeTimers();
    const ink = new BakedExportProof();
    const first = ink.wait(["kept ink"]);
    await vi.advanceTimersByTimeAsync(INK_PROOF_TIMEOUT_MS);
    await first;
    await ink.wait(["kept ink"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a sub-pixel mark to fall back and a newly visible mark to prove out early", async () => {
    vi.useFakeTimers();
    const ink = new BakedExportProof();
    const save = ink.wait(["tiny", "visible"]);
    ink.finish("tiny");
    ink.finish("visible");
    await save;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("only ignores a removed mark once the authoritative scene has passed the commit", async () => {
    vi.useFakeTimers();
    const ink = new BakedExportProof();
    ink.expect("removed ink");
    ink.accepted("removed ink", 4);
    const save = ink.wait([]);
    ink.reconcile(3, new Set());
    expect(vi.getTimerCount()).toBe(1);
    ink.reconcile(4, new Set());
    await save;
    expect(vi.getTimerCount()).toBe(0);
  });
});
