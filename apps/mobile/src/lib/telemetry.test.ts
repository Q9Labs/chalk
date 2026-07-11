import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileTelemetry, flushAndDisposeTelemetry } from "./telemetry";

describe("createMobileTelemetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds bearer authentication when a token provider exists", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const tokenProvider = vi.fn(async () => "local-token");
    const telemetry = createMobileTelemetry({ apiUrl: "http://127.0.0.1:8080", enabled: true, tokenProvider });
    telemetry.startJourney({ kind: "meeting.join" });
    await telemetry.flush();

    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8080/v1/telemetry/journey-events");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer local-token" }),
    });
    telemetry.dispose();
  });

  it("disposes only after a terminal flush settles", async () => {
    const calls: string[] = [];
    let finishFlush: (() => void) | undefined;
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = () => {
            calls.push("flush");
            resolve();
          };
        }),
    );
    const dispose = vi.fn(() => calls.push("dispose"));

    const completion = flushAndDisposeTelemetry({ flush, dispose });
    expect(dispose).not.toHaveBeenCalled();
    finishFlush?.();
    await completion;

    expect(calls).toEqual(["flush", "dispose"]);
  });
});
