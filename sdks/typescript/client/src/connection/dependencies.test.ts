import { describe, expect, it } from "vitest";

import type { ParsedAccessGrant } from "../access/grant";
import type { ConnectionAccessProvider, ConnectionAccessRequest, ConnectionClock } from "./dependencies";

describe("Connection dependency contracts", () => {
  it("keeps legacy zero-argument providers assignable while delivering refresh context to request-aware providers", async () => {
    const legacy: ConnectionAccessProvider = async () => ({ marker: "legacy" }) as unknown as ParsedAccessGrant;
    const requests: ConnectionAccessRequest[] = [];
    const contextual: ConnectionAccessProvider = async (request) => {
      if (request) requests.push(request);
      return { marker: "contextual" } as unknown as ParsedAccessGrant;
    };
    const request = { reason: "media_recovery", replaceMediaConnection: true } as const;

    await legacy();
    await contextual(request);
    expect(requests).toEqual([request]);
  });

  it("allows deterministic clocks at the runtime boundary", () => {
    const clock: ConnectionClock = { now: () => 42, setTimeout: () => "timer", clearTimeout: () => undefined };
    expect(clock.now()).toBe(42);
    expect(clock.setTimeout(() => undefined, 10)).toBe("timer");
  });
});
