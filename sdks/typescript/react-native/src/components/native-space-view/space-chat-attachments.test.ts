import { CHALK_CHAT_ATTACHMENT_LIMITS } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { normalizeChatFileDrafts, uploadAndSendNativeChatAttachments } from "./space-chat-attachments";

describe("native Space chat attachments", () => {
  it("accepts lazy file readers and enforces the client bounds", () => {
    const result = normalizeChatFileDrafts([
      { name: "note.txt", type: "text/plain", size: 5, arrayBuffer: async () => new TextEncoder().encode("hello").buffer },
      { fileName: "image.png", mimeType: "image/png", bytes: new Uint8Array([1, 2]).buffer },
    ]);

    expect(result.error).toBeNull();
    expect(result.files.map((file) => file.fileName)).toEqual(["note.txt", "image.png"]);
  });

  it("rejects unsupported types and excess staged files before upload", () => {
    expect(normalizeChatFileDrafts([{ name: "script.js", type: "application/javascript", size: 1, arrayBuffer: async () => new ArrayBuffer(1) }])).toMatchObject({ files: [], error: "This file type is not supported in Space chat." });
    const files = Array.from({ length: CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage + 1 }, (_, index) => ({ name: `note-${index}.txt`, type: "text/plain", size: 1, arrayBuffer: async () => new ArrayBuffer(1) }));
    expect(normalizeChatFileDrafts(files)).toMatchObject({ files: [], error: `You can attach up to ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files per message.` });
  });

  it("uploads every staged file before sending an attachment-only message", async () => {
    const files = normalizeChatFileDrafts([{ name: "note.txt", type: "text/plain", size: 1, arrayBuffer: async () => new ArrayBuffer(1) }]).files;
    const upload = vi.fn(async () => ({ attachmentId: "note.txt", fileName: "note.txt", mimeType: "text/plain" as const, byteLength: 1 }));
    const send = vi.fn(async () => undefined);

    await uploadAndSendNativeChatAttachments(files, "", upload, send);

    expect(upload).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ text: "", attachments: [{ attachmentId: "note.txt", fileName: "note.txt", mimeType: "text/plain", byteLength: 1 }] });
  });
});
