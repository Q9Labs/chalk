import { describe, expect, it } from "vitest";
import { parseArguments } from "./compose-fixture.js";

describe("compose fixture arguments", () => {
  it("uses the fixture defaults", () => {
    expect(parseArguments(["--output", "/tmp/fixture"])).toEqual({ outputDirectory: "/tmp/fixture", width: 1280, height: 720, durationMs: 120_000, fps: 15, colorScheme: "light" });
  });

  it("accepts media and color options and rejects invalid durations", () => {
    expect(parseArguments(["--output", "/tmp/fixture", "--media", "/tmp/media", "--color-scheme", "dark"])).toMatchObject({ mediaDirectory: "/tmp/media", colorScheme: "dark" });
    expect(() => parseArguments(["--output", "/tmp/fixture", "--duration-ms", "9999"])).toThrow("--duration-ms must be at least 10000");
    expect(() => parseArguments(["--output", "relative"])).toThrow("usage: compose-fixture");
  });
});
