import { describe, expect, it, vi } from "vitest";

import { CHALK_CHAT_ATTACHMENT_LIMITS } from "../room-actions/types";
import { createChalkChatFileHttpTransport } from "./http-transport";

describe("chat attachment HTTP transport", () => {
  it("initiates an idempotent participant-authenticated upload", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          attachmentId: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
          uploadId: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22",
          method: "PUT",
          uploadUrl: "https://uploads.test/chat/file",
          headers: { "content-type": "image/png", "x-amz-meta-chalk-upload-id": "upload-1" },
          expiresAt: "2026-07-30T10:00:00.000Z",
        },
        { status: 201 },
      ),
    );
    const transport = createChalkChatFileHttpTransport({
      baseUrl: "https://api.chalk.test/",
      token: async () => "participant-sync-token",
      fetch,
    });

    await expect(
      transport.initiateUpload({
        clientAttachmentId: "client-attachment-1",
        fileName: "diagram.png",
        mimeType: "image/png",
        byteLength: 2_048,
        sha256: "a".repeat(64),
      }),
    ).resolves.toMatchObject({ method: "PUT", attachmentId: expect.any(String) });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.chalk.test/v1/chat/attachments/uploads");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer participant-sync-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      clientAttachmentId: "client-attachment-1",
      fileName: "diagram.png",
      mimeType: "image/png",
      byteLength: 2_048,
      sha256: "a".repeat(64),
    });
  });

  it("finalizes uploads and resolves protected downloads", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          attachmentId: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
          fileName: "notes.txt",
          mimeType: "text/plain",
          byteLength: 128,
        }),
      )
      .mockResolvedValueOnce(Response.json({ downloadUrl: "https://downloads.test/notes", expiresAt: "2026-07-30T10:00:00.000Z" }));
    const transport = createChalkChatFileHttpTransport({
      baseUrl: "https://api.chalk.test",
      token: async () => "token",
      fetch,
    });

    await expect(transport.finalizeUpload("upload/1")).resolves.toMatchObject({ fileName: "notes.txt", byteLength: 128 });
    await expect(transport.getDownloadUrl("attachment/1")).resolves.toEqual({
      downloadUrl: "https://downloads.test/notes",
      expiresAt: "2026-07-30T10:00:00.000Z",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://api.chalk.test/v1/chat/attachments/uploads/upload%2F1/finalize", "https://api.chalk.test/v1/chat/attachments/attachment%2F1/download"]);
  });

  it("rejects invalid local metadata before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createChalkChatFileHttpTransport({
      baseUrl: "https://api.chalk.test",
      token: async () => "token",
      fetch,
    });

    await expect(
      transport.initiateUpload({
        clientAttachmentId: "too-short",
        fileName: "large.pdf",
        mimeType: "application/pdf",
        byteLength: CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength + 1,
        sha256: "invalid",
      }),
    ).rejects.toMatchObject({ operation: "initiate_upload", code: "invalid_payload", recoverable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed and denied responses with typed failures", async () => {
    const malformed = createChalkChatFileHttpTransport({
      baseUrl: "https://api.chalk.test",
      token: async () => "token",
      fetch: async () => Response.json({ attachmentId: "attachment-only" }),
    });
    const denied = createChalkChatFileHttpTransport({
      baseUrl: "https://api.chalk.test",
      token: async () => "token",
      fetch: async () => Response.json({}, { status: 403 }),
    });

    await expect(
      malformed.initiateUpload({
        clientAttachmentId: "client-attachment-1",
        fileName: "notes.txt",
        mimeType: "text/plain",
        byteLength: 1,
        sha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "file_transfer_failed" });
    await expect(denied.getDownloadUrl("attachment-1")).rejects.toMatchObject({ code: "permission_denied", recoverable: false });
  });
});
