import { describe, expect, it } from "vitest";
import { formatDuration, formatTime, selectedId, stateTone } from "./model";

describe("episode debugger model", () => {
  it("formats bounded durations and invalid timestamps as explicit unknowns", () => {
    expect(formatDuration(undefined)).toBe("unknown: not available");
    expect(formatDuration(650)).toBe("650 ms");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatTime("not-a-date")).toBe("unknown: invalid time");
  });

  it("maps states to design tones and identifies event selections by cursor", () => {
    expect(stateTone("timed_out")).toBe("danger");
    expect(stateTone("reconnecting")).toBe("warning");
    expect(stateTone("complete")).toBe("success");
    expect(selectedId({ kind: "event", value: { cursor: 17 } as never })).toBe("17");
  });
});
