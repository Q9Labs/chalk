import { describe, expect, it, vi } from "vitest";
import { type ChalkChatFileTransport, createChalkChatFileHttpTransport } from "../chat-files";
import { ConnectionLifecycleFailure } from "../connection/lifecycle";
import { ChalkChatFileError } from "../chat-files/types";
import { reportUploadFailure } from "./chat-upload-report";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

const message = "Could not reach the chat attachment service (network or browser access failure).";
const storageMessage = "Could not send the file to storage (network or browser access failure).";
const file = { fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello").buffer } as const;
const attachment = { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 } as const;

describe("public chat attachment failures", () => {
  it.each(["download", "upload"] as const)("preserves rejected credentials after access expires for %s", async (operation) => {
    let now = Date.now();
    const getAccess = vi
      .fn()
      .mockResolvedValueOnce(opaqueAccessGrant("chat-expired-token"))
      .mockResolvedValue(new Response(null, { status: 401 }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ attachmentId: "attachment-1", uploadId: "upload-1", method: "PUT", uploadUrl: "https://storage.example/upload", headers: { "content-type": "text/plain" }, expiresAt: "2030-01-01T00:00:00Z" }));
    const storageFetch = vi.fn<typeof globalThis.fetch>(async () => {
      now += 6 * 60_000;
      return new Response(null, { status: 200 });
    });
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess },
      {
        ...platform,
        fetch: storageFetch,
        dependencies: { ...platform.dependencies, createConnectionReporter: () => undefined, clock: { ...platform.dependencies.clock, now: () => now }, createChatFileTransport: ({ token }) => createChalkChatFileHttpTransport({ baseUrl: "https://api.chalk.test", token, fetch }) },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      if (operation === "download") now += 6 * 60_000;
      const result = operation === "upload" ? client.chat.files.upload(file) : client.chat.files.resolveUrl(attachment);
      await expect(result).rejects.toMatchObject({ code: "access.invalid", recoverable: false, message: "Access was rejected" });
      expect(getAccess).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(operation === "upload" ? 1 : 0);
      expect(storageFetch).toHaveBeenCalledTimes(operation === "upload" ? 1 : 0);
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
          createConnectionReporter: () => undefined,
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
      await expect(client.chat.files.resolveUrl(attachment)).rejects.toMatchObject({ code: "access.invalid", recoverable: false, message: "Access was rejected" });
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
      await expect(client.chat.files.upload(file)).rejects.toMatchObject({ code: "collaboration.unavailable", recoverable: true, message: storageMessage, uploadFailure: { kind: "storage_unreachable" } });
      expect(storageFetch).toHaveBeenCalledTimes(1);
      expect(descriptorFetch).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
    }
  });

  it("keeps the HTTP status when storage rejects the signed upload", async () => {
    const descriptorFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ attachmentId: "attachment-1", uploadId: "upload-1", method: "PUT", uploadUrl: "https://storage.example/upload", headers: { "content-type": "text/plain" }, expiresAt: "2099-01-01T00:00:00Z" }, { status: 201 }));
    const storageFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const client = attachmentClient(({ token }) => createChalkChatFileHttpTransport({ baseUrl: "https://api.chalk.test", token, fetch: descriptorFetch }), storageFetch);
    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.chat.files.upload(file)).rejects.toMatchObject({ code: "command.rejected", recoverable: false, message: "Attachment upload failed with HTTP 403", uploadFailure: { kind: "storage_rejected", httpStatus: 403 } });
    } finally {
      client.dispose();
    }
  });

  it("keeps the failure kind and HTTP status when the API refuses to start or finish an upload", async () => {
    const descriptor = () => Response.json({ attachmentId: "attachment-1", uploadId: "upload-1", method: "PUT", uploadUrl: "https://storage.example/upload", headers: { "content-type": "text/plain" }, expiresAt: "2099-01-01T00:00:00Z" }, { status: 201 });
    const stored = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(null, { status: 200 }));
    for (const { responses, uploadFailure } of [
      { responses: [new Response(null, { status: 403 })], uploadFailure: { kind: "initiate_failed", httpStatus: 403 } },
      { responses: [descriptor(), new Response(null, { status: 409 })], uploadFailure: { kind: "finalize_failed", httpStatus: 409 } },
    ]) {
      const apiFetch = vi.fn<typeof globalThis.fetch>();
      for (const response of responses) apiFetch.mockResolvedValueOnce(response);
      const client = attachmentClient(({ token }) => createChalkChatFileHttpTransport({ baseUrl: "https://api.chalk.test", token, fetch: apiFetch }), stored);
      try {
        await client.join({ microphone: false, camera: false });
        await expect(client.chat.files.upload(file)).rejects.toMatchObject({ code: "command.rejected", recoverable: false, uploadFailure });
      } finally {
        client.dispose();
      }
    }
  });
});

function attachmentClient(createChatFileTransport: (input: { readonly token: () => Promise<string> }) => ChalkChatFileTransport, fetch = vi.fn<typeof globalThis.fetch>()) {
  const platform = createCoreTestPlatform();
  return createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("chat-failure") }, { ...platform, fetch, dependencies: { ...platform.dependencies, createConnectionReporter: () => undefined, createChatFileTransport } });
}

describe("reporting a failed chat upload", () => {
  it("sends the failure kind and an HTTP status, and nothing else", () => {
    const recordTransportDiagnostic = vi.fn();
    const cause = new ChalkChatFileError({ operation: "store_upload", code: "file_transfer_failed", recoverable: false, message: "Attachment upload failed with HTTP 403 for https://storage.example/secret", httpStatus: 403 });
    reportUploadFailure({ recordTransportDiagnostic }, cause);
    expect(recordTransportDiagnostic).toHaveBeenCalledExactlyOnceWith({ event: "chat_upload_failed", upload_failure: "storage_rejected", http_status: 403 });
  });

  it.each([
    { operation: "initiate_upload", httpStatus: 403, upload_failure: "initiate_failed" },
    { operation: "finalize_upload", httpStatus: 409, upload_failure: "finalize_failed" },
  ] as const)("reports a failed $operation with its HTTP status", ({ operation, httpStatus, upload_failure }) => {
    const sent: unknown[] = [];
    reportUploadFailure({ recordTransportDiagnostic: (diagnostic) => void sent.push(diagnostic) }, new ChalkChatFileError({ operation, code: "permission_denied", recoverable: false, message: "Chat attachment request failed.", httpStatus }));
    expect(sent).toEqual([{ event: "chat_upload_failed", upload_failure, http_status: httpStatus }]);
  });

  it("reports nothing for an error that is not an upload failure", () => {
    const recordTransportDiagnostic = vi.fn();
    reportUploadFailure({ recordTransportDiagnostic }, new Error("boom"));
    expect(recordTransportDiagnostic).not.toHaveBeenCalled();
  });
});
