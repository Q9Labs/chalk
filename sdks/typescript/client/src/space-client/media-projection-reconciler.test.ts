import { afterEach, expect, it, vi } from "vitest";
import { MediaProjectionReconciler } from "./media-projection-reconciler";

afterEach(() => vi.useRealTimers());

function fixture(send = vi.fn(async () => undefined)) {
  vi.useFakeTimers();
  const report = vi.fn();
  const changed = vi.fn();
  const reconciler = new MediaProjectionReconciler({ now: Date.now, schedule: setTimeout, cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>), send, report, changed });
  const observation = { revision: 1, publicationId: "publication-1", enabled: true, projectedEnabled: false, projectedPublicationId: null };
  return { reconciler, observation, send, report, changed };
}

it("waits for the matching projection, not a successful target acknowledgement", async () => {
  const { reconciler, observation, send } = fixture();
  reconciler.observe("microphone", observation);
  expect(reconciler.state("microphone")).toBe("requesting");
  await vi.advanceTimersByTimeAsync(749);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledOnce();
  expect(reconciler.state("microphone")).toBe("requesting");
  reconciler.observe("microphone", { ...observation, projectedEnabled: true, projectedPublicationId: "publication-1" });
  expect(reconciler.state("microphone")).toBeNull();
  await vi.advanceTimersByTimeAsync(10000);
  expect(send).toHaveBeenCalledOnce();
});

it.each(["microphone", "camera"] as const)("bounds %s retries, reports the mismatch, and does not flap on snapshots", async (source) => {
  const { reconciler, observation, send, report } = fixture(
    vi.fn(async () => {
      throw new Error("private device label");
    }),
  );
  reconciler.observe(source, observation);
  for (let i = 0; i < 15; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    reconciler.observe(source, observation);
  }
  expect(send).toHaveBeenCalledTimes(3);
  expect(reconciler.state(source)).toBe("failed");
  expect(report.mock.calls.map(([event]) => event)).toEqual([
    { event: "media_projection_mismatch", source, publication_state: "on", projection_state: "off", duration_ms: 2750, attempt: 2, outcome: "started" },
    { event: "media_projection_mismatch", source, publication_state: "on", projection_state: "off", duration_ms: 3750, attempt: 3, outcome: "failed" },
  ]);
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
  reconciler.reset();
  reconciler.observe(source, observation);
  await vi.advanceTimersByTimeAsync(750);
  expect(send).toHaveBeenCalledTimes(4);
  reconciler.reset();
});

it("expires even a hung target, cancels on leave, and rechecks a new publication ID", async () => {
  const { reconciler, observation, send } = fixture(vi.fn(() => new Promise<void>(() => {})));
  reconciler.observe("microphone", observation);
  await vi.advanceTimersByTimeAsync(8750);
  expect(reconciler.state("microphone")).toBe("failed");
  expect(send).toHaveBeenCalledOnce();
  reconciler.observe("microphone", { ...observation, publicationId: "replacement" });
  expect(reconciler.state("microphone")).toBe("requesting");
  reconciler.reset();
  await vi.advanceTimersByTimeAsync(10000);
  expect(send).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
