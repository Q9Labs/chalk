import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultChalkSessionDependencies } from "./production";

describe("default ChalkSession production dependencies", () => {
  afterEach(() => vi.useRealTimers());

  it("provides the real clock and browser factory seams", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    const dependencies = createDefaultChalkSessionDependencies({ apiBaseURL: "https://api.chalk.video", syncURL: "wss://sync.chalk.video/v3" });
    const callback = vi.fn();
    const timer = dependencies.clock.setTimeout(callback, 25);

    expect(dependencies.clock.now()).toBe(Date.parse("2026-07-21T12:00:00.000Z"));
    expect(dependencies.createMediaClient).toBeTypeOf("function");
    expect(dependencies.createSyncClient).toBeTypeOf("function");
    vi.advanceTimersByTime(25);
    expect(callback).toHaveBeenCalledOnce();
    dependencies.clock.clearTimeout(timer);
  });
});
