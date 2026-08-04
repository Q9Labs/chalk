import type { ChatFilesController } from "../client-compat";
import { describe, expect, it, vi } from "vitest";

import { uploadChatAttachment } from "./upload-chat-attachment";

describe("uploadChatAttachment", () => {
  it("delegates a native file to the SpaceClient chat files controller", async () => {
    const attachment = { attachmentId: "attachment-1", fileName: "notes.txt", mimeType: "text/plain" as const, byteLength: 5 };
    const chatFiles = {
      upload: vi.fn(async () => attachment),
      url: vi.fn(() => "https://downloads.chalk.test/attachment-1"),
    } satisfies ChatFilesController;
    const file = {
      bytes: new Uint8Array([1, 2, 3, 4, 5]).buffer,
      fileName: "notes.txt",
      mimeType: "text/plain",
    };

    await expect(uploadChatAttachment(file, chatFiles)).resolves.toEqual(attachment);
    expect(chatFiles.upload).toHaveBeenCalledWith(file);
  });
});
