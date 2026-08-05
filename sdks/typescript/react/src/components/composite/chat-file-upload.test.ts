// @vitest-environment happy-dom

import type { ChatFilesController } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { uploadChatAttachment } from "./chat-file-upload";

describe("uploadChatAttachment", () => {
  it("delegates upload ownership to the SpaceClient chat files controller", async () => {
    const attachment = { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain" as const, byteLength: 5 };
    const chatFiles = {
      upload: vi.fn(async () => attachment),
      url: vi.fn(() => "https://download.test/attachment-1"),
    } satisfies ChatFilesController;
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    await expect(uploadChatAttachment(file, chatFiles)).resolves.toEqual(attachment);
    expect(chatFiles.upload).toHaveBeenCalledWith(file);
  });
});
