import { describe, expect, expectTypeOf, it } from "vitest";

import type { ChalkChatAttachment, ChalkChatReadReceipt } from "../collaboration/types";
import { ChalkChatFileError, type ChalkChatFileErrorCode, type ChalkChatFileFailure, type ChalkChatFileTransport } from "./types";

describe("chat attachment public types", () => {
  it("keeps file lifecycle and durable metadata exact", () => {
    expectTypeOf<Awaited<ReturnType<ChalkChatFileTransport["finalizeUpload"]>>>().toEqualTypeOf<ChalkChatAttachment>();
    expectTypeOf<Awaited<ReturnType<ChalkChatFileTransport["initiateUpload"]>>>().toEqualTypeOf<{
      readonly attachmentId: string;
      readonly uploadId: string;
      readonly method: "PUT";
      readonly uploadUrl: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly expiresAt: string;
    }>();
    expectTypeOf<ChalkChatReadReceipt>().toEqualTypeOf<{
      readonly participantId: string;
      readonly participantGeneration: number;
      readonly readThroughSequence: string;
      readonly readAt: string;
    }>();
  });

  it("projects stable transport failures", () => {
    expectTypeOf<ChalkChatFileErrorCode>().toEqualTypeOf<"access.invalid" | "unavailable" | "permission_denied" | "invalid_payload" | "conflict" | "not_found" | "expired" | "file_transfer_failed">();
    const failure = {
      operation: "finalize_upload",
      code: "file_transfer_failed",
      recoverable: false,
      message: "Attachment verification failed.",
    } satisfies ChalkChatFileFailure;

    expect(new ChalkChatFileError(failure)).toMatchObject({
      name: "ChalkChatFileError",
      operation: "finalize_upload",
      code: "file_transfer_failed",
      recoverable: false,
      message: "Attachment verification failed.",
    });
  });
});
