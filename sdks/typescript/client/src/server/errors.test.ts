import { describe, expect, it } from "vitest";
import { ChalkAPIError, ChalkServerOnlyError, errorCode, requestId } from "./errors";

describe("server errors", () => {
  it("keeps only bounded machine codes from API error bodies", () => {
    expect(errorCode({ error: { code: "rate_limited", message: "untrusted" } })).toBe("rate_limited");
    expect(errorCode({ error: { code: "UPPERCASE" } })).toBe("request_failed");
    expect(errorCode({ error: { code: `a${"b".repeat(64)}` } })).toBe("request_failed");
    expect(errorCode({ error: null })).toBe("request_failed");
    expect(errorCode(["invalid"])).toBe("request_failed");
  });

  it("accepts only bounded request identifiers and honors the standard header first", () => {
    expect(requestId(new Headers({ "x-request-id": "request-primary", "x-chalk-request-id": "request-fallback" }))).toBe("request-primary");
    expect(requestId(new Headers({ "x-request-id": "contains spaces" }))).toBeUndefined();
    expect(requestId(new Headers({ "x-request-id": "x".repeat(129) }))).toBeUndefined();
    expect(requestId(new Headers())).toBeUndefined();
  });

  it("uses fixed public messages and never retains a cause or server payload", () => {
    const network = new ChalkAPIError({ code: "network_error", retryable: true, status: 0 });
    const invalid = new ChalkAPIError({ code: "invalid_response", retryable: false, status: 200 });
    const failed = new ChalkAPIError({ code: "forbidden", requestId: "request", retryable: false, status: 403 });

    expect(network.message).toBe("The Chalk API could not be reached.");
    expect(invalid.message).toBe("The Chalk API returned an invalid response.");
    expect(failed).toMatchObject({ code: "forbidden", message: "The Chalk API request failed with HTTP 403.", name: "ChalkAPIError", requestId: "request", status: 403 });
    expect("cause" in failed).toBe(false);
  });

  it("exposes a stable server-only error identity", () => {
    expect(new ChalkServerOnlyError()).toMatchObject({ message: "The Chalk server client is available only in Node.js runtimes.", name: "ChalkServerOnlyError" });
  });
});
