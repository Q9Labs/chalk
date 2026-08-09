import { ChalkAPIError } from "@q9labsai/chalk-client/server";
import { describe, expect, it } from "vitest";

import { BrokerError } from "../src/contracts";
import { brokerErrorResponse } from "../src/errors";

describe("Episode broker error boundary", () => {
  it("preserves a valid Chalk API status instead of converting it to 502", async () => {
    const response = brokerErrorResponse(new ChalkAPIError({ code: "request_failed", retryable: false, status: 403 }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Access to the Episode was denied." });
  });

  it("fails closed for invalid upstream statuses", async () => {
    const response = brokerErrorResponse(new ChalkAPIError({ code: "invalid_response", retryable: false, status: 200 }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "The Episode broker could not complete the request." });
  });

  it("keeps broker errors and their response headers intact", async () => {
    const response = brokerErrorResponse(new BrokerError(429, "Too many Episode broker requests.", { "retry-after": "60" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "Too many Episode broker requests." });
  });
});
