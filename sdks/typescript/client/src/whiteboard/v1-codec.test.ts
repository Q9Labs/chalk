import { describe, expect, it } from "vitest";
import { decodeWhiteboardV1ClientFrame, decodeWhiteboardV1ServerFrame, encodeWhiteboardV1ClientFrame } from "./v1-codec";

const sceneId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";

describe("whiteboard-v1 codec", () => {
  it("round-trips strict client frames", () => {
    const frame = {
      type: "hello",
      protocol: "whiteboard-v1",
      token: "participant-token",
      cursor: { scene_id: sceneId, revision: "18446744073709551615" },
    } as const;

    expect(decodeWhiteboardV1ClientFrame(JSON.parse(encodeWhiteboardV1ClientFrame(frame)))).toEqual(frame);
  });

  it("rejects unknown server fields", () => {
    expect(() =>
      decodeWhiteboardV1ServerFrame(
        JSON.stringify({
          type: "reset_required",
          scene_id: sceneId,
          reason: "gap",
          extra: true,
        }),
      ),
    ).toThrow();
  });

  it("rejects the legacy participant wire field", () => {
    expect(() =>
      decodeWhiteboardV1ClientFrame({
        type: "set_draw_permission",
        operation_id: "operation-000001",
        participant_session_id: sceneId,
        can_draw: true,
      }),
    ).toThrow();
  });
});
