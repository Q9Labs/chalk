import { describe, expect, it } from "vitest";

import type { ParticipantAccess } from "./access";
import type { ChalkSessionAccessProvider, ChalkSessionAccessRequest, ChalkSessionClock } from "./dependencies";

describe("ChalkSession dependency contracts", () => {
  it("keeps legacy zero-argument providers assignable while delivering refresh context to request-aware providers", async () => {
    const legacy: ChalkSessionAccessProvider = async () => ({ marker: "legacy" }) as unknown as ParticipantAccess;
    const requests: ChalkSessionAccessRequest[] = [];
    const contextual: ChalkSessionAccessProvider = async (request) => {
      if (request) requests.push(request);
      return { marker: "contextual" } as unknown as ParticipantAccess;
    };
    const request = { reason: "media_recovery", replaceMediaConnection: true } as const;

    await legacy();
    await contextual(request);
    expect(requests).toEqual([request]);
  });

  it("allows deterministic clocks at the runtime boundary", () => {
    const clock: ChalkSessionClock = { now: () => 42, setTimeout: () => "timer", clearTimeout: () => undefined };
    expect(clock.now()).toBe(42);
    expect(clock.setTimeout(() => undefined, 10)).toBe("timer");
  });
});
