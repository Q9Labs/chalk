import { afterEach, describe, expect, it, vi } from "vitest";

const createV1SyncClient = vi.hoisted(() => vi.fn());
vi.mock("../sync", () => ({ createV1SyncClient }));

import { createDefaultConnectionDependencies } from "./production";

describe("default Connection production dependencies", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("provides the real clock and browser factory seams", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.chalk.video", syncURL: "wss://sync.chalk.video/v1" });
    const callback = vi.fn();
    const timer = dependencies.clock.setTimeout(callback, 25);

    expect(dependencies.clock.now()).toBe(Date.parse("2026-07-21T12:00:00.000Z"));
    expect(dependencies.createMediaClient).toBeTypeOf("function");
    expect(dependencies.createSyncClient).toBeTypeOf("function");
    expect(dependencies.createChatFileTransport).toBeTypeOf("function");
    expect(dependencies.createWhiteboardClient).toBeTypeOf("function");
    vi.advanceTimersByTime(25);
    expect(callback).toHaveBeenCalledOnce();
    dependencies.clock.clearTimeout(timer);
  });

  it("keeps native or custom runtimes free of a browser whiteboard client when disabled", () => {
    const dependencies = createDefaultConnectionDependencies({
      apiBaseURL: "https://api.chalk.video",
      syncURL: "wss://sync.chalk.video/v1/sync",
      whiteboardURL: null,
    });

    expect(dependencies.createWhiteboardClient).toBeUndefined();
  });

  it("passes the active journey context to the production Sync constructor", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.chalk.video", syncURL: "wss://sync.chalk.video/v1" });
    const telemetry = {
      journeyId: "00000000-0000-4000-8000-000000000001",
      rootJourneyId: "00000000-0000-4000-8000-000000000001",
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      tracestate: "chalk=test",
    };
    const input = {
      access: { subject: { tenantId: "tenant", episodeId: "episode", participantId: "participant" } },
      token: async () => "token",
      media: {},
      telemetry,
    } as unknown as Parameters<typeof dependencies.createSyncClient>[0];

    dependencies.createSyncClient(input);

    expect(createV1SyncClient).toHaveBeenCalledWith(expect.objectContaining({ telemetry }));
  });

  it("revalidates on visible browser wake and removes both listeners", () => {
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("window", windowTarget);
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.chalk.video", syncURL: "wss://sync.chalk.video/v1" });
    const listener = vi.fn();
    const unsubscribe = dependencies.subscribeForeground?.(listener);

    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe?.();
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
