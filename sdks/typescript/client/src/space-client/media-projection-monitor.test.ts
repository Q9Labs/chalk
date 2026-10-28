import { afterEach, expect, it, vi } from "vitest";
import { MediaProjectionMonitor } from "./media-projection-monitor";

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const report = vi.fn();
  const changed = vi.fn();
  const pause = vi.fn();
  const monitor = new MediaProjectionMonitor({ now: Date.now, schedule: setTimeout, cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>), report, pause, changed });
  const observation = { revision: 1, publicationId: "publication-1", enabled: true, projectedEnabled: false, projectedPublicationId: null };
  return { monitor, observation, report, changed, pause };
}

it("accepts a matching authoritative projection during the grace", async () => {
  const { monitor, observation, pause, report } = fixture();
  monitor.observe("microphone", observation);
  expect(monitor.state("microphone")).toBe("requesting");
  await vi.advanceTimersByTimeAsync(9999);
  expect(pause).not.toHaveBeenCalled();
  monitor.observe("microphone", { ...observation, projectedEnabled: true, projectedPublicationId: observation.publicationId });
  expect(monitor.state("microphone")).toBeNull();
  await vi.advanceTimersByTimeAsync(20000);
  expect(pause).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  monitor.reset();
});

it.each(["microphone", "camera"] as const)("pauses unconfirmed %s once and requires a fresh action, despite publication churn", async (source) => {
  const { monitor, observation, pause, report } = fixture();
  for (let i = 0; i < 20; ++i) {
    monitor.observe(source, { ...observation, publicationId: `replacement-${i}` });
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(monitor.state(source)).toBe("failed");
  expect(pause).toHaveBeenCalledExactlyOnceWith(source, observation.revision);
  expect(report).toHaveBeenCalledExactlyOnceWith({ event: "media_projection_mismatch", source, publication_state: "on", projection_state: "off", duration_ms: 10000, attempt: 0, outcome: "failed" });
  monitor.observe(source, { ...observation, projectedEnabled: true, projectedPublicationId: observation.publicationId });
  expect(monitor.state(source)).toBe("failed");
  monitor.observe(source, { ...observation, enabled: false });
  expect(monitor.state(source)).toBe("failed");
  monitor.observe(source, { ...observation, revision: 2 });
  expect(monitor.state(source)).toBe("requesting");
  monitor.reset();
});

it("reports projection-on without local capture once and never pauses another client's publication", async () => {
  const { monitor, observation, pause, report } = fixture();
  const foreign = { ...observation, enabled: false, publicationId: null, projectedEnabled: true, projectedPublicationId: "other-client" };
  monitor.observe("microphone", foreign);
  expect(monitor.state("microphone")).toBeNull();
  await vi.advanceTimersByTimeAsync(10000);
  monitor.observe("microphone", { ...foreign, projectedEnabled: false });
  monitor.observe("microphone", foreign);
  await vi.advanceTimersByTimeAsync(20000);
  expect(pause).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledExactlyOnceWith({ event: "media_projection_mismatch", source: "microphone", publication_state: "off", projection_state: "on", duration_ms: 10000, attempt: 0, outcome: "started" });
  monitor.reset();
});

it("cancels the grace on leave", async () => {
  const { monitor, observation, pause, report } = fixture();
  monitor.observe("microphone", observation);
  monitor.reset();
  await vi.advanceTimersByTimeAsync(20000);
  expect(pause).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses late unconfirmed capture even if off/on drift was already reported", async () => {
  const { monitor, observation, pause, report } = fixture();
  monitor.observe("microphone", { ...observation, enabled: false, projectedEnabled: true, projectedPublicationId: "other-client" });
  await vi.advanceTimersByTimeAsync(11000);
  monitor.observe("microphone", observation);
  expect(pause).toHaveBeenCalledExactlyOnceWith("microphone", observation.revision);
  expect(monitor.state("microphone")).toBe("failed");
  expect(report).toHaveBeenCalledOnce();
  monitor.reset();
});
