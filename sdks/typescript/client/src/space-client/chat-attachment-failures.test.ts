import { describe, expect, it, vi } from "vitest";
import { type ChalkChatFileTransport, createChalkChatFileHttpTransport } from "../chat-files";
import { ConnectionLifecycleFailure } from "../connection/lifecycle";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

const message = "Could not reach the chat attachment service (network or browser access failure).";
const file = { fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello").buffer } as const;
const attachment = { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 } as const;

describe("public chat attachment failures", () => {
  it("does not make a permanently rejected access refresh retryable", async () => {
    let now = Date.now();
    const getAccess = vi
      .fn()
      .mockResolvedValueOnce(opaqueAccessGrant("chat-expired-token"))
      .mockResolvedValue(new Response(null, { status: 401 }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess },
      { ...platform, dependencies: { ...platform.dependencies, clock: { ...platform.dependencies.clock, now: () => now }, createChatFileTransport: ({ token }) => createChalkChatFileHttpTransport({ baseUrl: "https://api.chalk.test", token, fetch }) } },
    );
    try {
      await client.join({ microphone: false, camera: false });
      now += 6 * 60_000;
      await expect(client.chat.files.resolveUrl(attachment)).rejects.toMatchObject({ code: "access.invalid", recoverable: false });
      expect(getAccess).toHaveBeenCalledTimes(2);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("preserves invalid access rejected by the attachment token provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("chat-token-rejected") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          createChatFileTransport: () =>
            createChalkChatFileHttpTransport({
              baseUrl: "https://api.chalk.test",
              token: async () => {
                throw new ConnectionLifecycleFailure({ code: "invalid_access", recoverable: false, message: "Access was rejected" });
              },
              fetch,
            }),
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.chat.files.resolveUrl(attachment)).rejects.toMatchObject({ code: "access.invalid", recoverable: false, message });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it.each([
    { stage: "token", code: "access.unavailable" },
    { stage: "request", code: "collaboration.unavailable" },
  ] as const)("preserves recoverable $stage failures through upload and download", async ({ stage, code }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = attachmentClient(({ token }) =>
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
    );
    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.chat.files.upload(file)).rejects.toMatchObject({ code, recoverable: true, message });
      await expect(client.chat.files.resolveUrl(attachment)).rejects.toMatchObject({ code, recoverable: true, message });
      expect(fetch).toHaveBeenCalledTimes(stage === "token" ? 0 : 2);
    } finally {
      client.dispose();
    }
  });

  it("reports a rejected signed storage upload as a browser or network failure", async () => {
    const descriptorFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ attachmentId: "attachment-1", uploadId: "upload-1", method: "PUT", uploadUrl: "https://storage.example/upload", headers: { "content-type": "text/plain" }, expiresAt: "2030-01-01T00:00:00Z" }));
    const storageFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = attachmentClient(({ token }) => createChalkChatFileHttpTransport({ baseUrl: "https://api.chalk.test", token, fetch: descriptorFetch }), storageFetch);
    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.chat.files.upload(file)).rejects.toMatchObject({ code: "collaboration.unavailable", recoverable: true, message });
      expect(storageFetch).toHaveBeenCalledTimes(1);
      expect(descriptorFetch).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
    }
  });
});

function attachmentClient(createChatFileTransport: (input: { readonly token: () => Promise<string> }) => ChalkChatFileTransport, fetch = vi.fn<typeof globalThis.fetch>()) {
  const platform = createCoreTestPlatform();
  return createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("chat-failure") }, { ...platform, fetch, dependencies: { ...platform.dependencies, createChatFileTransport } });
}
