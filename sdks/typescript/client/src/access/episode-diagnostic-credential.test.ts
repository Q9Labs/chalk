import { describe, expect, it } from "vitest";
import { parseEpisodeDiagnosticCredential, validEpisodeDiagnosticCredential } from "./episode-diagnostic-credential";

const EXPIRES_AT = "2026-07-21T12:05:00.000Z";
const INTAKE_PATH = "/_internal/episode-diagnostic-events";

describe("episode diagnostic credentials", () => {
  it("parses a valid diagnostics audience and freezes the normalized credential", () => {
    const parsed = parseEpisodeDiagnosticCredential(wireCredential());

    expect(parsed).toEqual({ token: diagnosticToken(), expiresAt: EXPIRES_AT, generation: 3, intakePath: INTAKE_PATH });
    expect(Object.isFrozen(parsed)).toBe(true);
    if (!parsed) throw new Error("expected a parsed credential");
    expect(validEpisodeDiagnosticCredential(parsed, Date.parse("2026-07-21T12:00:00.000Z"))).toBe(true);
  });

  it.each([
    ["non-object input", null],
    ["wrong audience", { ...wireCredential(), token: diagnosticToken("chalk-sync") }],
    ["malformed token", { ...wireCredential(), token: "not-a-jwt" }],
    ["invalid base64 payload", { ...wireCredential(), token: "header.%not-base64%.signature" }],
    ["valid base64 but non-JSON payload", { ...wireCredential(), token: "header.aGVsbG8.signature" }],
    ["invalid expiry", { ...wireCredential(), expires_at: "not-a-date" }],
    ["timezone-less expiry", { ...wireCredential(), expires_at: "2026-07-21T12:05:00.000" }],
    ["nonexistent calendar date", { ...wireCredential(), expires_at: "2026-02-29T12:05:00.000Z" }],
    ["hour 24", { ...wireCredential(), expires_at: "2026-07-21T24:00:00.000Z" }],
    ["non-positive generation", { ...wireCredential(), generation: 0 }],
    ["wrong intake path", { ...wireCredential(), intake_path: "/diagnostics" }],
  ])("rejects %s", (_name, value) => {
    const parse = () => parseEpisodeDiagnosticCredential(value);
    expect(parse).not.toThrow();
    expect(parse()).toBeNull();
  });

  it("stops accepting an otherwise valid credential at its expiry", () => {
    const credential = parseEpisodeDiagnosticCredential(wireCredential());
    if (!credential) throw new Error("expected a parsed credential");

    expect(validEpisodeDiagnosticCredential(credential, Date.parse(EXPIRES_AT))).toBe(false);
    expect(validEpisodeDiagnosticCredential({ ...credential, generation: 0 }, Date.parse("2026-07-21T12:00:00.000Z"))).toBe(false);
    expect(validEpisodeDiagnosticCredential({ ...credential, expiresAt: "2026-02-29T12:05:00.000Z" }, Date.parse("2026-02-28T12:00:00.000Z"))).toBe(false);
  });

  it("accepts an explicitly zoned RFC3339 offset", () => {
    const credential = parseEpisodeDiagnosticCredential({ ...wireCredential(), expires_at: "2026-07-21T12:05:00+05:00" });

    expect(credential?.expiresAt).toBe("2026-07-21T12:05:00+05:00");
  });

  it("accepts a real leap day", () => {
    const credential = parseEpisodeDiagnosticCredential({ ...wireCredential(), expires_at: "2028-02-29T12:05:00.000Z" });

    expect(credential?.expiresAt).toBe("2028-02-29T12:05:00.000Z");
  });
});

function wireCredential() {
  return { token: diagnosticToken(), expires_at: EXPIRES_AT, generation: 3, intake_path: INTAKE_PATH };
}

function diagnosticToken(audience = "chalk-diagnostics") {
  return `${btoa("header")}.${btoa(JSON.stringify({ aud: audience }))}.signature`;
}
