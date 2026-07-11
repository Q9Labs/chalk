import { describe, expect, it } from "vitest";
import { createUuid, randomHex } from "./random";

describe("telemetry identifiers", () => {
  it("creates hexadecimal entropy and RFC 4122 UUIDs", () => {
    expect(randomHex(8)).toMatch(/^[a-f0-9]{16}$/);
    expect(createUuid()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
});
