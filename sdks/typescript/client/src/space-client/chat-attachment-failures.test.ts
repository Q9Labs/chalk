import { describe, expect, it, vi } from "vitest";
import { createChalkChatFileHttpTransport } from "../chat-files";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

const message = "Could not reach the chat attachment service (network or browser access failure).";
const attachment = { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 } as const;

describe("public chat attachment failures", () => {
  it.each([
    { stage: "token", code: "access.unavailable" },
    { stage: "request", code: "collaboration.unavailable" },
  ] as const)("preserves recoverable $stage failures through upload and download", async ({ stage, code }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("chat-failure") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          createChatFileTransport: ({ token }) =>
            createChalkChatFileHttpTransport({
              baseUrl: "https://api.chalk.test",
              token:
                stage === "token"
                  ? async () => {
                      throw new Error("Token refresh failed");
                    }
                  : token,
              fetch,
            }),
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.chat.files.upload({ fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello").buffer })).rejects.toMatchObject({ code, recoverable: true, message });
      await expect(client.chat.files.resolveUrl(attachment)).rejects.toMatchObject({ code, recoverable: true, message });
      expect(fetch).toHaveBeenCalledTimes(stage === "token" ? 0 : 2);
    } finally {
      client.dispose();
    }
  });

  it("reports a rejected signed storage upload as a browser or network failure", async () => {
    const descriptorFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ attachmentId: "attachment-1", uploadId: "upload-1", method: "PUT", uploadUrl: "https://storage.example/upload", headers: { "content-type": "text/plain" }, expiresAt: "2030-01-01T00:00:00Z" }));
    const storageFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("chat-storage-failure") },
      { ...platform, fetch: storageFetch, dependencies: { ...platform.dependencies, createChatFileTransport: ({ token }) => createChalkChatFileHttpTransport({ baseUrl: "https://api.chalk.test", token, fetch: descriptorFetch }) } },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.chat.files.upload({ fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello").buffer })).rejects.toMatchObject({ code: "collaboration.unavailable", recoverable: true, message });
      expect(storageFetch).toHaveBeenCalledTimes(1);
      expect(descriptorFetch).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
    }
  });
});
