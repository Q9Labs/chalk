import { describe, expect, it } from "vitest";

import { formatMessageTime } from "./message-time";

describe("formatMessageTime", () => {
  it("formats message timestamps with the shared display contract", () => {
    expect(formatMessageTime("2026-08-25T12:05:00")).toBe("12:05 PM");
  });
});
