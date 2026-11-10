import { describe, expect, it, vi } from "vitest";

import type { ChalkChatFileTransport } from "../chat-files";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import type { ChatAttachment, ChatUploadFile } from "./types";

class BrowserFileWithBytesMethod extends File {
  bytes = vi.fn(async () => new Uint8Array(await this.arrayBuffer()));
}

describe("SpaceClient Chat attachment uploads", () => {
  it.each(["browser", "native"])("uploads %s file contents without confusing a bytes method with native bytes", async (kind) => {
    const bytes = new TextEncoder().encode("hello").buffer;
    const browserFile = new BrowserFileWithBytesMethod([bytes], "note.txt", { type: "text/plain" });
    const file: ChatUploadFile = kind === "browser" ? browserFile : { fileName: "note.txt", mimeType: "text/plain", bytes };
    const attachment: ChatAttachment = { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 };
    const initiateUpload = vi.fn<ChalkChatFileTransport["initiateUpload"]>().mockResolvedValue({ attachmentId: attachment.attachmentId, uploadId: "upload-1", method: "PUT", uploadUrl: "https://storage.example/upload", headers: { "content-type": "text/plain" }, expiresAt: "2026-09-07T00:00:00Z" });
    const finalizeUpload = vi.fn<ChalkChatFileTransport["finalizeUpload"]>().mockResolvedValue(attachment);
    const transport: ChalkChatFileTransport = { initiateUpload, finalizeUpload, getDownloadUrl: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("chat-upload") }, { ...platform, fetch, dependencies: { ...platform.dependencies, createChatFileTransport: () => transport } });

    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.chat.files.upload(file)).resolves.toEqual(attachment);
      expect(initiateUpload).toHaveBeenCalledWith(expect.objectContaining({ fileName: "note.txt", mimeType: "text/plain", byteLength: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }));
      expect(fetch).toHaveBeenCalledWith("https://storage.example/upload", { method: "PUT", headers: { "content-type": "text/plain" }, body: bytes });
      expect(fetch.mock.contexts).toEqual([undefined]);
      expect(finalizeUpload).toHaveBeenCalledWith("upload-1");
      expect(browserFile.bytes).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });
});
