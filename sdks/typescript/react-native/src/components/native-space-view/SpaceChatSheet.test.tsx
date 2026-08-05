import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SpaceChatSheet.tsx", import.meta.url), "utf8");

describe("SpaceChatSheet", () => {
  it("keeps attachment, retry, and accessible composition flows", () => {
    expect(source).toContain('accessibilityLabel="Attach file"');
    expect(source).toContain("controller.chatAttachments.map");
    expect(source).toContain("controller.removeChatAttachment(index)");
    expect(source).toContain("chatAttachmentUploading");
    expect(source).toContain("chatAttachmentError");
    expect(source).toContain("!controller.chatDraft.trim() && controller.chatAttachments.length === 0");
    expect(source).toContain('accessibilityLabel="Send message"');
    expect(source).toContain("retryMessage(message.clientMessageId)");
    expect(source).toContain('accessibilityRole="link"');
  });
});
