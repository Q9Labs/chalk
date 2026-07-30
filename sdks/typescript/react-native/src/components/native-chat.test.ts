import { describe, expect, it } from "vitest";
import { formatChatAttachmentSize, isLatestChatMessageVisible } from "./native-chat";

describe("native chat viewport", () => {
  it("reports the latest message only when the viewport reaches the content bottom", () => {
    expect(isLatestChatMessageVisible({ contentHeight: 600, viewportHeight: 300, scrollOffset: 120 })).toBe(false);
    expect(isLatestChatMessageVisible({ contentHeight: 600, viewportHeight: 300, scrollOffset: 292 })).toBe(true);
  });

  it("does not treat unmeasured content as visible", () => {
    expect(isLatestChatMessageVisible({ contentHeight: 0, viewportHeight: 300, scrollOffset: 0 })).toBe(false);
    expect(isLatestChatMessageVisible({ contentHeight: 300, viewportHeight: 0, scrollOffset: 0 })).toBe(false);
  });
});

describe("native chat attachment metadata", () => {
  it("formats byte lengths for compact attachment rows", () => {
    expect(formatChatAttachmentSize(512)).toBe("512 B");
    expect(formatChatAttachmentSize(1_536)).toBe("1.5 KB");
    expect(formatChatAttachmentSize(2_097_152)).toBe("2.0 MB");
  });
});
