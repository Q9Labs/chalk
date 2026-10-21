import { describe, expect, it } from "vitest";
import { mediaFailureMessage } from "./media-failure-copy";

describe("native media failure feedback", () => {
  it.each(["microphone", "camera"] as const)("keeps %s feedback safe and actionable", (permission) => {
    expect(mediaFailureMessage(permission, "connection.invalid_state")).toBe("Still connecting. Try again in a moment.");
    expect(mediaFailureMessage(permission, "media.timeout")).toBe("The call did not respond. Try again.");
    expect(mediaFailureMessage(permission, "client.internal_error")).toBe(`Couldn’t turn on your ${permission}. Try again.`);
    expect(mediaFailureMessage(permission, null)).toBe(`Couldn’t turn on your ${permission}. Try again.`);
  });
});
