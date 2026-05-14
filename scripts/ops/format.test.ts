import { describe, expect, it } from "vitest";
import { filterIncident, incidentGlyph, relativeAge, timestampValue, trimCell } from "./format";
import type { OpsIncident } from "./types";

const incident: OpsIncident = {
  incident_code: "INC-20260513-01",
  title: "Realtime join failures",
  summary: "Elevated room join failures",
  severity: "critical",
  status: "investigating",
  visibility: "internal",
  component_ids: ["realtime"],
};

describe("ops TUI formatting", () => {
  it("normalizes Go nullable timestamps", () => {
    expect(timestampValue({ Time: "2026-05-13T04:30:00Z", Valid: true })).toBe("2026-05-13T04:30:00Z");
    expect(timestampValue({ Time: "2026-05-13T04:30:00Z", Valid: false })).toBeNull();
    expect(timestampValue("not-a-date")).toBeNull();
  });

  it("uses distinct incident glyphs", () => {
    expect(incidentGlyph(incident)).toBe("!");
    expect(incidentGlyph({ ...incident, severity: "major" })).toBe("◐");
    expect(incidentGlyph({ ...incident, status: "resolved" })).toBe("✓");
  });

  it("filters across title, code, state, and component ids", () => {
    expect(filterIncident(incident, "join")).toBe(true);
    expect(filterIncident(incident, "realtime")).toBe(true);
    expect(filterIncident(incident, "resolved")).toBe(false);
  });

  it("keeps terminal cells stable", () => {
    expect(trimCell("abcd", 6)).toBe("abcd  ");
    expect(trimCell("abcdef", 4)).toBe("abc…");
  });

  it("formats relative age with compact units", () => {
    const now = new Date("2026-05-13T04:31:30Z").getTime();
    expect(relativeAge("2026-05-13T04:31:00Z", now)).toBe("30s ago");
    expect(relativeAge("2026-05-13T04:01:00Z", now)).toBe("30m ago");
  });
});
