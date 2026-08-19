import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ChalkWhiteboardV1Error,
  type ChalkJsonValue,
  type ChalkSharedWhiteboardAppState,
  type ChalkWhiteboardV1Commit,
  type ChalkWhiteboardV1Element,
  type ChalkWhiteboardV1ErrorCode,
  type ChalkWhiteboardV1Event,
  type ChalkWhiteboardV1Failure,
  type ChalkWhiteboardV1FileTransport,
  type ChalkWhiteboardV1Operation,
  type ChalkWhiteboardV1Transport,
  type ChalkWhiteboardV1UpdateInput,
} from "./types";

describe("whiteboard public types", () => {
  it("keeps JSON, element, update, and app-state boundaries canonical", () => {
    expectTypeOf<ChalkJsonValue>().toEqualTypeOf<null | boolean | number | string | readonly ChalkJsonValue[] | { readonly [key: string]: ChalkJsonValue }>();
    expectTypeOf<ChalkWhiteboardV1Element>().toEqualTypeOf<{
      readonly id: string;
      readonly type: string;
      readonly version: number;
      readonly versionNonce: number;
      readonly index: string;
      readonly isDeleted: boolean;
      readonly payload: Readonly<Record<string, ChalkJsonValue>>;
    }>();
    expectTypeOf<ChalkSharedWhiteboardAppState>().toEqualTypeOf<{
      readonly viewBackgroundColor?: string;
    }>();
    expectTypeOf<ChalkWhiteboardV1UpdateInput>().toEqualTypeOf<{
      readonly sceneId: string;
      readonly syncAll: boolean;
      readonly elements: readonly ChalkWhiteboardV1Element[];
    }>();
  });

  it("freezes event discriminants and durable commit values", () => {
    expectTypeOf<ChalkWhiteboardV1Event["type"]>().toEqualTypeOf<"snapshot" | "update" | "cursor" | "reset_required">();
    expectTypeOf<Extract<ChalkWhiteboardV1Event, { type: "cursor" }>["participantId"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<ChalkWhiteboardV1Event, { type: "reset_required" }>["reason"]>().toEqualTypeOf<"scene_changed" | "cursor_expired" | "gap">();
    expectTypeOf<Extract<ChalkWhiteboardV1Event, { type: "snapshot" }>["appState"]>().toEqualTypeOf<ChalkSharedWhiteboardAppState | undefined>();
    expectTypeOf<ChalkWhiteboardV1Commit>().toEqualTypeOf<{
      readonly operationId: string;
      readonly sceneId: string;
      readonly revision: string;
    }>();
  });

  it("freezes operations, error codes, and failure values", () => {
    expectTypeOf<ChalkWhiteboardV1Operation>().toEqualTypeOf<"start_scene_subscription" | "submit_update" | "request_snapshot" | "clear" | "set_draw_permission" | "set_presentation" | "initiate_file_upload" | "finalize_file_upload" | "get_file_download">();
    expectTypeOf<ChalkWhiteboardV1ErrorCode>().toEqualTypeOf<"unavailable" | "permission_denied" | "invalid_payload" | "stale_scene" | "cursor_reset_required" | "storage_unavailable" | "file_transfer_failed">();
    expectTypeOf<ChalkWhiteboardV1Failure>().toEqualTypeOf<{
      readonly operation: ChalkWhiteboardV1Operation;
      readonly code: ChalkWhiteboardV1ErrorCode;
      readonly recoverable: boolean;
      readonly message: string;
    }>();
  });

  it("keeps the upload response and transport methods exact", () => {
    expectTypeOf<ReturnType<ChalkWhiteboardV1FileTransport["initiateUpload"]>>().toEqualTypeOf<
      Promise<{
        readonly uploadId: string;
        readonly method: "PUT";
        readonly uploadUrl: string;
        readonly headers: Readonly<Record<string, string>>;
        readonly expiresAt: string;
      }>
    >();
    expectTypeOf<Parameters<ChalkWhiteboardV1Transport["submitUpdate"]>[0]>().toEqualTypeOf<ChalkWhiteboardV1UpdateInput>();
    expectTypeOf<ReturnType<ChalkWhiteboardV1Transport["clear"]>>().toEqualTypeOf<Promise<ChalkWhiteboardV1Commit>>();
    expectTypeOf<Parameters<ChalkWhiteboardV1Transport["setDrawPermission"]>>().toEqualTypeOf<[participantId: string, canDraw: boolean]>();
    expectTypeOf<Parameters<ChalkWhiteboardV1Transport["setPresentation"]>>().toEqualTypeOf<[presenting: boolean]>();
    expectTypeOf<ChalkWhiteboardV1Transport["files"]>().toEqualTypeOf<ChalkWhiteboardV1FileTransport>();
  });
});

describe("ChalkWhiteboardV1Error", () => {
  it("projects a failure into a stable runtime error", () => {
    const failure = {
      operation: "submit_update",
      code: "stale_scene",
      recoverable: true,
      message: "The whiteboard scene changed.",
    } satisfies ChalkWhiteboardV1Failure;

    expect(new ChalkWhiteboardV1Error(failure)).toMatchObject({
      name: "ChalkWhiteboardV1Error",
      message: "The whiteboard scene changed.",
      operation: "submit_update",
      code: "stale_scene",
      recoverable: true,
    });
  });

  it("preserves an explicit cause without retaining the failure object", () => {
    const failure = {
      operation: "initiate_file_upload",
      code: "storage_unavailable",
      recoverable: true,
      message: "Whiteboard file storage is unavailable.",
    } satisfies ChalkWhiteboardV1Failure;
    const cause = new Error("network");
    const error = new ChalkWhiteboardV1Error(failure, { cause });

    expect(error.cause).toBe(cause);
    expect("failure" in error).toBe(false);
  });
});
