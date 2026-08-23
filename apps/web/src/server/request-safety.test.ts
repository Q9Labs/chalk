import { describe, expect, it } from "vitest";
import { accountCookieName, csrfCookieName, forwardedContextHeaders, hasMatchingCsrfProof, readCookie, stripTokenFields, validJourneyID } from "./request-safety";

describe("request safety", () => {
  it("forwards only valid trace context with the current journey", () => {
    const request = new Request("https://chalk.test", {
      headers: {
        "X-Chalk-Journey-ID": "ignored",
        Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        Tracestate: "vendor=value",
      },
    });
    const headers = forwardedContextHeaders(request, "11111111-1111-4111-8111-111111111111");

    expect(headers.get("x-chalk-journey-id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(headers.get("traceparent")).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(headers.get("tracestate")).toBe("vendor=value");
    const filtered = forwardedContextHeaders(new Request("https://chalk.test", { headers: { Traceparent: "not-a-traceparent", Tracestate: "x".repeat(513) } }), "22222222-2222-4222-8222-222222222222");
    expect(filtered.get("traceparent")).toBeNull();
    expect(filtered.get("tracestate")).toBeNull();
  });

  it("uses secure cookie names and requires matching CSRF proof", () => {
    expect(accountCookieName(new URL("https://chalk.test"))).toBe("__Host-chalk_account");
    expect(csrfCookieName(new URL("https://chalk.test"))).toBe("__Host-chalk_csrf");
    expect(readCookie("other=ignored; chalk_account=encoded%20token", "chalk_account")).toBe("encoded token");
    expect(hasMatchingCsrfProof(new Request("https://chalk.test", { headers: { Cookie: "chalk_csrf=csrf%20token", "X-Chalk-CSRF": " csrf token " } }), "chalk_csrf", "X-Chalk-CSRF")).toBe(true);
    expect(hasMatchingCsrfProof(new Request("https://chalk.test", { headers: { Cookie: "chalk_csrf=csrf-token", "X-Chalk-CSRF": "different" } }), "chalk_csrf", "X-Chalk-CSRF")).toBe(false);
  });

  it("normalizes journey IDs and removes token-shaped fields recursively", () => {
    expect(validJourneyID("ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")).toBe("abcdefab-cdef-4abc-8def-abcdefabcdef");
    expect(validJourneyID("not-a-uuid")).toBeUndefined();
    const value = { token: "root-token", refresh_token: "refresh-token", user: { name: "Ada", access_token: "access-token", secret: "retain" }, items: [{ credential: "retain", token: "item-token" }] };
    expect(stripTokenFields(value)).toEqual({ user: { name: "Ada", secret: "retain" }, items: [{ credential: "retain" }] });
    expect(stripTokenFields(value, ["secret", "credential"])).toEqual({ user: { name: "Ada" }, items: [{}] });
  });
});
