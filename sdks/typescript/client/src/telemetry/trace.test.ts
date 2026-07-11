import { describe, expect, it } from "vitest";
import { createTraceContext, parseTraceparent } from "./trace";

describe("W3C trace context", () => {
  it("continues a valid parent trace with a fresh span", () => {
    const parent = "00-11111111111111111111111111111111-2222222222222222-01";
    const child = createTraceContext(parent);

    expect(parseTraceparent(child.traceparent)?.traceId).toBe("11111111111111111111111111111111");
    expect(child.spanId).not.toBe("2222222222222222");
  });
});
