import { describe, expect, it, vi } from "vitest";

import { createChalkChatFileHttpTransport } from "../chat-files";
import type { ChatAttachment } from "./types";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

describe("SpaceClient Chat attachment downloads", () => {
  it("resolves a signed URL through an authenticated descriptor request and allows retry", async () => {
    const platform = createCoreTestPlatform();
    const access = opaqueAccessGrant("chat-download");
    const signedUrl = "https://storage.example/photo.png?signature=test-signature";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ downloadUrl: signedUrl, expiresAt: "2026-09-05T16:00:00.000Z" }));
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => access },
      {
        ...platform,
        apiBaseUrl: "https://api.chalk.test",
        dependencies: {
          ...platform.dependencies,
          createChatFileTransport: ({ token }) => createChalkChatFileHttpTransport({ baseUrl: "https://api.chalk.test", token, fetch }),
        },
      },
    );
    const attachment: ChatAttachment = { attachmentId: "attachment/image 1", fileName: "photo.png", mimeType: "image/png", byteLength: 42 };

    try {
      await client.join({ microphone: false, camera: false });
      expect(client.chat.files.url(attachment)).toBe("https://api.chalk.test/v1/chat/attachments/attachment%2Fimage%201/download");

      await expect(client.chat.files.resolveUrl(attachment)).rejects.toThrow("Chat attachment request failed");
      await expect(client.chat.files.resolveUrl(attachment)).resolves.toBe(signedUrl);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[0]).toBe("https://api.chalk.test/v1/chat/attachments/attachment%2Fimage%201/download");
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${access.sync.token}`);
      expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(`Bearer ${access.sync.token}`);
    } finally {
      client.dispose();
    }
  });
});
