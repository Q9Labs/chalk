import type { ChatUploadFile } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";

import { describeChatUploadFile } from "./space-chat-attachments";

describe("describeChatUploadFile", () => {
  it("describes a lazy native picker file that also exposes bytes", () => {
    const file: ChatUploadFile = new LazyNativeFileWithBytes();

    expect(describeChatUploadFile(file)).toMatchObject({ fileName: "mobile-photo.png", mimeType: "image/png", byteLength: 7 });
  });
});

class LazyNativeFileWithBytes {
  readonly name = "mobile-photo.png";
  readonly type = "image/png";
  readonly size = 7;

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(this.size));
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.size));
  }
}
