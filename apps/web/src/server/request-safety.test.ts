import { describe, expect, it } from "vitest";
import { accountCookieName, csrfCookieName, forwardedContextHeaders, hasMatchingCsrfProof, readCookie, stripTokenFields, validJourneyID } from "./request-safety";

describe("request safety helpers", () => {
  it("forwards only valid trace context alongside the journey", () => {
    const request = new Request("https://chalk.test", {
      headers: {
        "X-Chalk-Journey-ID": "ignored-by-helper",
        Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        Tracestate: "vendor=value",
      },
    });

    const headers = forwardedContextHeaders(request, "11111111-1111-4111-8111-111111111111");

    expect(headers.get("x-chalk-journey-id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(headers.get("traceparent")).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(headers.get("tracestate")).toBe("vendor=value");

    const unsafe = new Request("https://chalk.test", {
      headers: {
        Traceparent: "not-a-traceparent",
        Tracestate: "x".repeat(513),
      },
    });
    const filtered = forwardedContextHeaders(unsafe, "22222222-2222-4222-8222-222222222222");

    expect(filtered.get("traceparent")).toBeNull();
    expect(filtered.get("tracestate")).toBeNull();
  });

  it("selects secure cookie names and decodes cookie values", () => {
    expect(accountCookieName(new URL("https://chalk.test"))).toBe("__Host-chalk_account");
    expect(accountCookieName(new URL("http://localhost:3070"))).toBe("chalk_account_local");
    expect(csrfCookieName(new URL("https://chalk.test"))).toBe("__Host-chalk_csrf");
    expect(csrfCookieName(new URL("http://localhost:3070"))).toBe("chalk_csrf_local");
    expect(readCookie("other=ignored; chalk_account=encoded%20token; duplicate=last", "chalk_account")).toBe("encoded token");
    expect(readCookie(null, "chalk_account")).toBeUndefined();
    expect(readCookie("chalk_account=%E0%A4%A", "chalk_account")).toBeUndefined();
  });

  it("requires matching CSRF proof and normalizes journey IDs", () => {
    const request = new Request("https://chalk.test", {
      headers: {
        Cookie: "chalk_csrf=csrf%20token",
        "X-Chalk-CSRF": " csrf token ",
      },
    });

    expect(hasMatchingCsrfProof(request, "chalk_csrf", "X-Chalk-CSRF")).toBe(true);
    expect(hasMatchingCsrfProof(new Request("https://chalk.test", { headers: { Cookie: "chalk_csrf=csrf-token", "X-Chalk-CSRF": "different" } }), "chalk_csrf", "X-Chalk-CSRF")).toBe(false);
    expect(validJourneyID("ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")).toBe("abcdefab-cdef-4abc-8def-abcdefabcdef");
    expect(validJourneyID("not-a-uuid")).toBeUndefined();
    expect(validJourneyID(null)).toBeUndefined();
  });

  it("accepts PostgreSQL UUID-shaped journey IDs while rejecting malformed values", () => {
    expect(validJourneyID("00000000-0000-0000-c000-000000000001")).toBe("00000000-0000-0000-c000-000000000001");
    for (const value of ["00000000-0000-0000-c000-00000000000g", "00000000-0000-0000-c000-0000000000000", "000000000000000000000000000000000000"]) {
      expect(validJourneyID(value)).toBeUndefined();
    }
  });

  it("strips token-shaped fields recursively while honoring caller-specific keys", () => {
    const value = {
      token: "root-token",
      refresh_token: "refresh-token",
      user: { name: "Hasan", access_token: "access-token", secret: "retain-by-default" },
      items: [{ credential: "retain-by-default", token: "item-token" }],
    };

    expect(stripTokenFields(value)).toEqual({ user: { name: "Hasan", secret: "retain-by-default" }, items: [{ credential: "retain-by-default" }] });
    expect(stripTokenFields(value, ["secret", "credential"])).toEqual({ user: { name: "Hasan" }, items: [{}] });
  });
});
