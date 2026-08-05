import { beforeEach, describe, expect, it, vi } from "vitest";

const picker = vi.hoisted(() => vi.fn());
const fileArrayBuffer = vi.hoisted(() => vi.fn(async () => new Uint8Array([1, 2, 3]).buffer));
const fileConstructor = vi.hoisted(() => {
  class FakeFile {
    readonly arrayBuffer = fileArrayBuffer;
    readonly size = 3;
    readonly type = "text/plain";

    constructor(readonly uri: string) {}
  }
  return vi.fn(FakeFile);
});

vi.mock("expo-document-picker", () => ({ getDocumentAsync: picker }));
vi.mock("expo-file-system", () => ({ File: fileConstructor }));
vi.mock("@q9labsai/chalk-client", () => ({
  CHALK_CHAT_ATTACHMENT_LIMITS: { maximumPerMessage: 5, maximumByteLength: 25 * 1024 * 1024, maximumFileNameBytes: 255 },
  CHALK_CHAT_ATTACHMENT_MIME_TYPES: ["text/plain", "image/png"],
}));

import { CHALK_CHAT_ATTACHMENT_LIMITS } from "@q9labsai/chalk-client";
import { pickMobileChatFiles } from "./chat-files";

beforeEach(() => {
  picker.mockReset();
  fileArrayBuffer.mockClear();
  fileConstructor.mockClear();
});

describe("pickMobileChatFiles", () => {
  it("returns no files when the native picker is canceled", async () => {
    picker.mockResolvedValue({ canceled: true, assets: null });

    await expect(pickMobileChatFiles()).resolves.toEqual([]);
    expect(fileConstructor).not.toHaveBeenCalled();
  });

  it("maps a multi-file selection to lazy canonical upload files", async () => {
    picker.mockResolvedValue({
      canceled: false,
      assets: [
        { name: "notes.txt", mimeType: "text/plain", size: 4, uri: "file:///notes.txt" },
        { name: "fallback.txt", mimeType: undefined, uri: "file:///fallback.txt" },
      ],
    });

    const files = await pickMobileChatFiles();

    expect(picker).toHaveBeenCalledWith({ copyToCacheDirectory: true, multiple: true, type: expect.any(Array) });
    expect(fileConstructor).toHaveBeenNthCalledWith(1, "file:///notes.txt");
    expect(fileConstructor).toHaveBeenNthCalledWith(2, "file:///fallback.txt");
    expect(files).toMatchObject([
      { name: "notes.txt", size: 4, type: "text/plain" },
      { name: "fallback.txt", size: 3, type: "text/plain" },
    ]);
    expect(fileArrayBuffer).not.toHaveBeenCalled();
    const first = files[0];
    if (!first || !("arrayBuffer" in first)) throw new Error("Expected a lazy upload file.");
    await first.arrayBuffer();
    expect(fileArrayBuffer).toHaveBeenCalledOnce();
  });

  it("bounds native multi-pick to the canonical per-message limit", async () => {
    picker.mockResolvedValue({
      canceled: false,
      assets: Array.from({ length: CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage + 1 }, (_, index) => ({ name: `file-${index}.txt`, uri: `file:///file-${index}.txt` })),
    });

    await expect(pickMobileChatFiles()).rejects.toThrow(`Choose at most ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files.`);
    expect(fileConstructor).not.toHaveBeenCalled();
  });
});
