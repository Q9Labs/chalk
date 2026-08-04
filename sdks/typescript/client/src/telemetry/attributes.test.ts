import { describe, expect, it } from "vitest";
import { normalizeTelemetryAttributes } from "./attributes";

describe("normalizeTelemetryAttributes", () => {
  it("bounds keys, values, and attribute count", () => {
    const attributes = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`key_${index}`, "x".repeat(300)]));
    const normalized = normalizeTelemetryAttributes({ ...attributes, "": "ignored" });

    expect(Object.keys(normalized ?? {})).toHaveLength(24);
    expect(normalized?.key_0).toHaveLength(256);
    expect(Object.hasOwn(normalized ?? {}, "")).toBe(false);
  });

  it("drops sensitive credentials and domain identifiers across key styles", () => {
    const normalized = normalizeTelemetryAttributes({
      ACCESS_TOKEN: "token",
      "authorization-header": "Bearer secret",
      "space-id": "space-1",
      EpisodeId: "episode-1",
      participant_identifier: "participant-1",
      safe_metric: 3,
    });

    expect(normalized).toEqual({ safe_metric: 3 });
  });

  it("places reserved fields before caller attributes", () => {
    const normalized = normalizeTelemetryAttributes(Object.fromEntries([...Array.from({ length: 30 }, (_, index) => [`custom_${index}`, index] as const), ["category", "episode"], ["code", "episode.started"]]), { reservedKeys: ["category", "code"] });

    expect(Object.keys(normalized ?? {})).toHaveLength(24);
    expect(normalized).toMatchObject({ category: "episode", code: "episode.started", custom_0: 0 });
    expect(normalized).not.toHaveProperty("custom_22");
  });
});
