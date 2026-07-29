import { describe, expect, it } from "vitest";
import { createChalkWhiteboardV1Client } from "./v1-create";

describe("createChalkWhiteboardV1Client", () => {
  it("accepts explicit platform adapters", () => {
    const client = createChalkWhiteboardV1Client({
      url: "ws://sync.test/v1/whiteboard",
      token: async () => "participant-token",
      files: {
        initiateUpload: async () => ({
          uploadId: "upload",
          method: "PUT",
          uploadUrl: "https://uploads.test/object",
          headers: {},
          expiresAt: "2026-07-29T12:00:00.000Z",
        }),
        finalizeUpload: async () => undefined,
        getDownloadUrl: async () => ({
          downloadUrl: "https://downloads.test/object",
          expiresAt: "2026-07-29T12:00:00.000Z",
        }),
      },
      lifecycle: { subscribe: () => () => undefined },
      webSocket: {
        connect: () => ({
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: () => undefined,
          close: () => undefined,
        }),
      },
    });

    expect(client).toBeInstanceOf(Object);
  });
});
