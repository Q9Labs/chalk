import type { ChatUploadFile } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";

import { describeChatUploadFile } from "./chat-upload-file";

describe("describeChatUploadFile", () => {
  it("describes a browser file whose Blob prototype exposes bytes", () => {
    const file: ChatUploadFile = new BrowserFileWithBytes();

    expect(describeChatUploadFile(file)).toEqual({ fileName: "browser-note.txt", mimeType: "text/plain", byteLength: 5 });
  });

  it("describes Chalk raw bytes", () => {
    const file: ChatUploadFile = { fileName: "raw-note.txt", mimeType: "text/plain", bytes: new ArrayBuffer(5) };

    expect(describeChatUploadFile(file)).toEqual({ fileName: "raw-note.txt", mimeType: "text/plain", byteLength: 5 });
  });
});

class BrowserFileWithBytes {
  readonly name = "browser-note.txt";
  readonly type = "text/plain";
  readonly size = 5;

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(this.size));
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.size));
  }
}
