// @vitest-environment happy-dom

import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { uploadChatAttachment } from "./chat-file-upload";

describe("uploadChatAttachment", () => {
  it("uses only the signed PUT headers and finalizes after a successful upload", async () => {
    const calls: string[] = [];
    const chatFiles = {
      initiateUpload: vi.fn(async () => {
        calls.push("initiate");
        return {
          attachmentId: "attachment-1",
          uploadId: "upload-1",
          method: "PUT" as const,
          uploadUrl: "https://upload.test/signed",
          headers: { "content-type": "text/plain", "x-amz-meta-sha256": "signed-value" },
          expiresAt: "2026-07-30T11:00:00.000Z",
        };
      }),
      finalizeUpload: vi.fn(async () => {
        calls.push("finalize");
        return { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 };
      }),
      getDownloadUrl: vi.fn(),
    } satisfies NonNullable<ChalkSessionStore["chatFiles"]>;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push("put");
      expect(init?.headers).toEqual({ "content-type": "text/plain", "x-amz-meta-sha256": "signed-value" });
      return new Response(null, { status: 200 });
    });

    await expect(uploadChatAttachment(new File(["hello"], "note.txt", { type: "text/plain" }), chatFiles, { fetch, randomUUID: () => "client-attachment-1" })).resolves.toEqual({
      attachmentId: "attachment-1",
      fileName: "note.txt",
      mimeType: "text/plain",
      byteLength: 5,
    });
    expect(chatFiles.initiateUpload).toHaveBeenCalledWith(expect.objectContaining({ clientAttachmentId: "client-attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
    expect(fetch).toHaveBeenCalledWith("https://upload.test/signed", expect.objectContaining({ method: "PUT" }));
    expect(chatFiles.finalizeUpload).toHaveBeenCalledWith("upload-1");
    expect(calls).toEqual(["initiate", "put", "finalize"]);
  });
});
