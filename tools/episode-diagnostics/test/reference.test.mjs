import { describe, expect, it } from "vitest";
import { formatReference, parseReference } from "../src/reference.mjs";
import { sanitizeDiagnosticData } from "../src/safety.mjs";

describe("diagnostic references", () => {
  it("round-trips umbrella, focus, and cursor references", () => {
    const input = "chalkdiag:v1:development:diag_123:issue:issue_9@42";
    const parsed = parseReference(input);
    expect(parsed.focus).toEqual({ kind: "issue", id: "issue_9" });
    expect(parsed.cursor).toBe(42);
    expect(formatReference(parsed)).toBe(input);
  });

  it.each(["chalkdiag:v1:prod:diag", "chalkdiag:v1:localhost:diag:op", "chalkdiag:v1:localhost:diag@01", "chalkdiag:v2:localhost:diag"])('rejects unsafe reference "%s"', (input) => {
    expect(() => parseReference(input)).toThrowError(/Malformed|out of bounds/u);
  });
});

describe("diagnostic output safety", () => {
  it("redacts credentials and network payloads before rendering", () => {
    const output = sanitizeDiagnosticData({ token: "fixture-secret", displayName: "Private Name", nested: { safe: "ok", address: "192.0.2.10", value: "https://private.invalid/path" } });
    expect(JSON.stringify(output)).not.toContain("fixture-secret");
    expect(JSON.stringify(output)).not.toContain("192.0.2.10");
    expect(output.token).toEqual({ unknownReason: "redacted" });
  });
});
