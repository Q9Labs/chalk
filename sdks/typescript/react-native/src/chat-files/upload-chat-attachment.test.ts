import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { uploadChatAttachment } from "./upload-chat-attachment";

type ChatFiles = NonNullable<ChalkSessionStore["chatFiles"]>;

describe("uploadChatAttachment", () => {
  it("hashes, uploads, and finalizes a supported file", async () => {
    const initiateUpload = vi.fn(async () => ({
      attachmentId: "attachment-1",
      uploadId: "upload-1",
      method: "PUT" as const,
      uploadUrl: "https://uploads.chalk.test/file",
      headers: { "content-type": "text/plain" },
      expiresAt: "2026-07-30T12:00:00.000Z",
    }));
    const finalizeUpload = vi.fn(async () => ({
      attachmentId: "attachment-1",
      fileName: "notes.txt",
      mimeType: "text/plain" as const,
      byteLength: 5,
    }));
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const chatFiles = {
      initiateUpload,
      finalizeUpload,
      getDownloadUrl: vi.fn(),
    } satisfies ChatFiles;

    await expect(
      uploadChatAttachment(
        {
          bytes: new Uint8Array([1, 2, 3, 4, 5]).buffer,
          fileName: "notes.txt",
          mimeType: "text/plain",
        },
        chatFiles,
        {
          digestSha256: async () => "a".repeat(64),
          fetch,
          randomUUID: () => "client-attachment-1",
        },
      ),
    ).resolves.toEqual({
      attachmentId: "attachment-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      byteLength: 5,
    });
    expect(initiateUpload).toHaveBeenCalledWith({
      clientAttachmentId: "client-attachment-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      byteLength: 5,
      sha256: "a".repeat(64),
    });
    expect(fetch).toHaveBeenCalledWith("https://uploads.chalk.test/file", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: expect.any(ArrayBuffer),
    });
    expect(finalizeUpload).toHaveBeenCalledWith("upload-1");
  });

  it("rejects unsupported file types before reserving an upload", async () => {
    const initiateUpload = vi.fn();
    const chatFiles = {
      initiateUpload,
      finalizeUpload: vi.fn(),
      getDownloadUrl: vi.fn(),
    } as unknown as ChatFiles;

    await expect(
      uploadChatAttachment(
        {
          bytes: new Uint8Array([1]).buffer,
          fileName: "archive.zip",
          mimeType: "application/zip",
        },
        chatFiles,
      ),
    ).rejects.toThrow("not supported");
    expect(initiateUpload).not.toHaveBeenCalled();
  });
});
