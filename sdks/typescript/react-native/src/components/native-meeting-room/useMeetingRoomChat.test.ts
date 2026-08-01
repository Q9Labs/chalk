import type { ChalkChatFileTransport } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));

vi.mock("react", () => ({
  useState: <T>(initial: T): readonly [T, (next: T) => void] => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({ Linking: linking }));

import { useMeetingRoomChat } from "./useMeetingRoomChat";

describe("useMeetingRoomChat", () => {
  it("keeps the empty composer inert and opens attachment download links", async () => {
    const getDownloadUrl = vi.fn(async () => ({ downloadUrl: "https://example.test/download", expiresAt: "later" }));
    const run = vi.fn(async (action: () => unknown | Promise<unknown>) => {
      await action();
    });
    const chat = useMeetingRoomChat({
      session: { chatFiles: chatFiles({ getDownloadUrl }) },
      chat: { sendMessage: vi.fn(async () => undefined), markAsRead: vi.fn(async () => undefined) },
      pickChatAttachments: undefined,
      run,
    });

    chat.sendChatMessage();
    expect(run).not.toHaveBeenCalled();

    chat.openChatAttachment("attachment-1");
    await Promise.resolve();
    expect(getDownloadUrl).toHaveBeenCalledWith("attachment-1");
    expect(linking.openURL).toHaveBeenCalledWith("https://example.test/download");
  });
});

function chatFiles(overrides: Pick<ChalkChatFileTransport, "getDownloadUrl">): ChalkChatFileTransport {
  return {
    initiateUpload: vi.fn(async () => ({ attachmentId: "attachment", uploadId: "upload", method: "PUT" as const, uploadUrl: "https://example.test/upload", headers: {}, expiresAt: "later" })),
    finalizeUpload: vi.fn(async () => ({ attachmentId: "attachment", fileName: "file.txt", mimeType: "text/plain", byteLength: 0, sha256: "hash" })),
    getDownloadUrl: overrides.getDownloadUrl,
  };
}
