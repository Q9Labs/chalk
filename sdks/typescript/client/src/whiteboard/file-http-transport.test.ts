import { describe, expect, it, vi } from "vitest";
import { createChalkWhiteboardV1FileHttpTransport } from "./file-http-transport";

const sceneId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const uploadId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";

describe("whiteboard-v1 file HTTP transport", () => {
  it("initiates with active-scene fencing and returns required signed headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        uploadId,
        method: "PUT",
        uploadUrl: "https://uploads.test/object",
        headers: { "content-type": "image/png", "x-amz-meta-sha256": "abc" },
        expiresAt: "2026-07-29T12:05:00.000Z",
      }),
    );
    const transport = createChalkWhiteboardV1FileHttpTransport({
      baseUrl: "https://api.test/",
      token: async () => "participant-token",
      sceneId: () => sceneId,
      fetch,
    });

    await expect(
      transport.initiateUpload({
        fileId: "file-1",
        mimeType: "image/png",
        byteLength: 128,
        sha256: "abc",
      }),
    ).resolves.toMatchObject({ uploadId, method: "PUT", headers: { "content-type": "image/png" } });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/v1/whiteboard/files/uploads",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          fileId: "file-1",
          mimeType: "image/png",
          byteLength: 128,
          sha256: "abc",
          sceneId,
        }),
      }),
    );
    const headers = fetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer participant-token");
  });

  it("uses participant-bound finalize and download routes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          downloadUrl: "https://downloads.test/object",
          expiresAt: "2026-07-29T12:05:00.000Z",
        }),
      );
    const transport = createChalkWhiteboardV1FileHttpTransport({
      baseUrl: "https://api.test",
      token: async () => "participant-token",
      sceneId: () => sceneId,
      fetch,
    });

    await expect(transport.finalizeUpload(uploadId)).resolves.toBeUndefined();
    await expect(transport.getDownloadUrl("file/1")).resolves.toMatchObject({
      downloadUrl: "https://downloads.test/object",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`https://api.test/v1/whiteboard/files/uploads/${uploadId}/finalize`, "https://api.test/v1/whiteboard/files/file%2F1/download"]);
  });

  it("rejects malformed success data and maps participant denial", async () => {
    const malformed = createChalkWhiteboardV1FileHttpTransport({
      baseUrl: "https://api.test",
      token: async () => "participant-token",
      sceneId: () => sceneId,
      fetch: async () => Response.json({ uploadUrl: "javascript:alert(1)" }),
    });
    await expect(malformed.initiateUpload({ fileId: "file", mimeType: "image/png", byteLength: 1, sha256: "abc" })).rejects.toMatchObject({
      code: "file_transfer_failed",
      recoverable: false,
    });

    const denied = createChalkWhiteboardV1FileHttpTransport({
      baseUrl: "https://api.test",
      token: async () => "participant-token",
      sceneId: () => sceneId,
      fetch: async () => new Response(null, { status: 403 }),
    });
    await expect(denied.getDownloadUrl("file")).rejects.toMatchObject({
      code: "permission_denied",
      recoverable: false,
    });
  });
});
