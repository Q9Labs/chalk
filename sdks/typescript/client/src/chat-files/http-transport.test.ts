import { describe, expect, it, vi } from "vitest";
import { createChalkChatFileHttpTransport } from "./http-transport";
import type { ChalkChatFileTransport } from "./types";

const reachabilityMessage = "Could not reach the chat attachment service (network or browser access failure).";
const operations = [
  { operation: "initiate_upload", invoke: (transport: ChalkChatFileTransport) => transport.initiateUpload({ clientAttachmentId: "attachment-client-id", fileName: "hello.txt", mimeType: "text/plain", byteLength: 5, sha256: "a".repeat(64) }) },
  { operation: "finalize_upload", invoke: (transport: ChalkChatFileTransport) => transport.finalizeUpload("upload-id") },
  { operation: "get_download", invoke: (transport: ChalkChatFileTransport) => transport.getDownloadUrl("attachment-id") },
] as const;

const baseUrl = "https://attachments.example.test";

describe("chat attachment request failures", () => {
  it.each(operations)("does not blame storage when $operation cannot reach the API", async ({ operation, invoke }) => {
    const cause = new TypeError("Failed to fetch");
    const transport = createChalkChatFileHttpTransport({ baseUrl, token: async () => "participant-token", fetch: vi.fn<typeof fetch>().mockRejectedValue(cause) });

    await expect(invoke(transport)).rejects.toMatchObject({ name: "ChalkChatFileError", operation, code: "unavailable", recoverable: true, message: reachabilityMessage, cause });
  });

  it.each(operations)("keeps token failure separate before $operation sends a request", async ({ operation, invoke }) => {
    const cause = new Error("Token refresh failed");
    const fetchImplementation = vi.fn<typeof fetch>();
    const transport = createChalkChatFileHttpTransport({
      baseUrl,
      token: async () => {
        throw cause;
      },
      fetch: fetchImplementation,
    });

    await expect(invoke(transport)).rejects.toMatchObject({ name: "ChalkChatFileError", operation, code: "unavailable", stage: "token", recoverable: true, message: reachabilityMessage, cause });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("names storage only when the readable service response confirms it", async () => {
    const transport = createChalkChatFileHttpTransport({ baseUrl, token: async () => "participant-token", fetch: async () => Response.json({ error: { code: "chat.storage_unavailable", message: "Chat attachment storage unavailable" } }, { status: 503 }) });

    await expect(transport.getDownloadUrl("attachment-id")).rejects.toMatchObject({ code: "unavailable", recoverable: true, message: "Chat attachment storage is unavailable." });
  });

  it.each([
    { label: "another service error", status: 503, body: JSON.stringify({ error: { code: "service.unavailable" } }) },
    { label: "an unreadable response", status: 503, body: "<html>Gateway unavailable</html>" },
    { label: "an empty response", status: 503, body: "" },
    { label: "a different error shape", status: 503, body: JSON.stringify({ code: "chat.storage_unavailable" }) },
    { label: "an access rejection", status: 401, body: JSON.stringify({ error: { code: "chat.storage_unavailable" } }) },
  ])("does not claim storage failed for $label", async ({ status, body }) => {
    const transport = createChalkChatFileHttpTransport({ baseUrl, token: async () => "participant-token", fetch: async () => new Response(body, { status }) });

    await expect(transport.getDownloadUrl("attachment-id")).rejects.toMatchObject({ message: "Chat attachment request failed." });
  });

  it.each([
    { status: 401, code: "access.invalid", recoverable: false },
    { status: 403, code: "permission_denied", recoverable: false },
    { status: 429, code: "unavailable", recoverable: true },
  ])("preserves the classification for HTTP $status", async ({ status, code, recoverable }) => {
    const transport = createChalkChatFileHttpTransport({ baseUrl, token: async () => "participant-token", fetch: async () => Response.json({ error: { code: "access.invalid" } }, { status }) });

    await expect(transport.getDownloadUrl("attachment-id")).rejects.toMatchObject({ code, recoverable });
  });
});
