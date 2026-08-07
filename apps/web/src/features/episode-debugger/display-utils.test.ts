import { describe, expect, it } from "vitest";
import { participantIdentityDisplay, safeIdentifierDisplay, safeReferenceLabel } from "./display-utils";

describe("display-utils", () => {
  it("preserves allowlisted raw IDs but describes opaque and missing values", () => {
    expect(safeIdentifierDisplay({ idClass: "chalk.request", value: "request-7", copyable: true })).toBe("request-7");
    expect(safeIdentifierDisplay({ idClass: "provider", value: "provider-raw", copyable: false })).toBe("unknown: opaque identifier omitted");
    expect(safeIdentifierDisplay({ idClass: "chalk.command", unknownReason: "not_retained", copyable: false })).toBe("unknown: not retained");
  });

  it("never turns a Participant raw identity into display text", () => {
    expect(participantIdentityDisplay({ value: "private-user" })).toBe("unknown: raw identity omitted");
    expect(participantIdentityDisplay({ unknownReason: "not_observable" })).toBe("unknown: not observable");
    expect(safeReferenceLabel({ idClass: "chalk.journey", value: "journey-7", copyable: true })).toBe("journey-7");
  });
});
