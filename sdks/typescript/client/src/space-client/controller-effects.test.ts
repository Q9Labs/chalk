import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ChalkChatFileTransport } from "../chat-files";
import type { ConnectionLifecycleCapability } from "../connection";
import { uploadFileEffect } from "./controller-effects";

describe("chat.files.upload", () => {
  it("uses only signed upload headers and finalizes through the access-gated port", async () => {
    const calls: string[] = [];
    const transport: ChalkChatFileTransport = {
      initiateUpload: vi.fn(async () => {
        calls.push("initiate");
        return {
          attachmentId: "attachment-1",
          uploadId: "upload-1",
          method: "PUT",
          uploadUrl: "https://upload.test/signed",
          headers: { "content-type": "text/plain", "x-amz-meta-sha256": "signed-value" },
          expiresAt: "2026-08-04T12:05:00.000Z",
        };
      }),
      finalizeUpload: vi.fn(async () => {
        calls.push("finalize");
        return { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 };
      }),
      getDownloadUrl: vi.fn(),
    };
    const fetch = vi.fn(function (this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBeUndefined();
      calls.push("put");
      expect(init?.headers).toEqual({ "content-type": "text/plain", "x-amz-meta-sha256": "signed-value" });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const runPortCommand = vi.fn(<T>(operation: () => Effect.Effect<T, unknown>) => operation());
    const connection = {
      createId: () => "client-attachment-1",
      runPortCommand,
    } as unknown as ConnectionLifecycleCapability;

    await expect(Effect.runPromise(uploadFileEffect(new BrowserFileWithBytes(), { connection, chatFiles: transport, fetch }))).resolves.toEqual({
      attachmentId: "attachment-1",
      fileName: "note.txt",
      mimeType: "text/plain",
      byteLength: 5,
    });
    expect(runPortCommand).toHaveBeenCalledOnce();
    expect(transport.initiateUpload).toHaveBeenCalledWith(expect.objectContaining({ clientAttachmentId: "client-attachment-1", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
    expect(transport.finalizeUpload).toHaveBeenCalledWith("upload-1");
    expect(calls).toEqual(["initiate", "put", "finalize"]);
  });
});

class BrowserFileWithBytes {
  readonly name = "note.txt";
  readonly type = "text/plain";
  readonly size = 5;

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new TextEncoder().encode("hello").buffer);
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode("hello"));
  }
}
