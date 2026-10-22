import { describe, expect, it } from "vitest";
import { decodeWhiteboardV1ServerFrame, encodeWhiteboardV1ClientFrame } from "./v1-codec";

const sceneId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";

describe("whiteboard-v1 codec", () => {
  it("carries authenticated leadership stamps and rejects incomplete or unbounded pairs", () => {
    const view = {
      type: "view",
      x: 1,
      y: 2,
      width: 300,
      height: 200,
      bring: false,
      origin_participant_id: sceneId,
      origin_sequence: 1,
      origin_connection_id: sceneId,
      origin_lead_stamp: "9007199254740993:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      origin_epoch: sceneId,
    } as const;
    expect(JSON.parse(encodeWhiteboardV1ClientFrame(view))).toEqual(view);
    const remote = { ...view, origin_proof: "a".repeat(64), participant_id: sceneId, display_name: "Ada", occurred_at: "2026-10-21T00:00:00Z" };
    expect(decodeWhiteboardV1ServerFrame(JSON.stringify(remote))).toEqual(remote);
    for (const bad of [
      { ...view, origin_connection_id: undefined },
      { ...view, origin_lead_stamp: "-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { ...view, origin_lead_stamp: "18446744073709551616:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ]) {
      expect(() => encodeWhiteboardV1ClientFrame(bad)).toThrow();
    }
  });
  it("rejects overflowing view rectangles on both wire boundaries", () => {
    const view = { type: "view", x: 0, y: 0, width: 800, height: 600, bring: true } as const;
    for (const field of ["x", "y", "width", "height"]) {
      const unsafe = { ...view, [field]: 1.7e308 };
      expect(() => encodeWhiteboardV1ClientFrame(unsafe)).toThrow();
      expect(() => decodeWhiteboardV1ServerFrame(JSON.stringify({ ...unsafe, participant_id: sceneId, display_name: "Ada", occurred_at: "2026-10-21T00:00:00Z" }))).toThrow();
    }
  });
  it("encodes strict client frames", () => {
    const frame = {
      type: "hello",
      protocol: "whiteboard-v1",
      token: "participant-token",
      cursor: { scene_id: sceneId, revision: "18446744073709551615" },
    } as const;

    expect(JSON.parse(encodeWhiteboardV1ClientFrame(frame))).toEqual(frame);

    const extended = { ...frame, extensions: [{ name: "presentation_v1" }] } as const;
    expect(JSON.parse(encodeWhiteboardV1ClientFrame(extended))).toEqual(extended);
  });

  it("accepts both legacy and negotiated welcomes", () => {
    const welcome = {
      type: "welcome",
      protocol: "whiteboard-v1",
      participant_id: sceneId,
      participant_generation: 1,
      capabilities: ["drawWhiteboard"],
      participant_capabilities: ["drawWhiteboard"],
      scene_id: sceneId,
      revision: "1",
      can_draw: true,
    } as const;

    expect(decodeWhiteboardV1ServerFrame(JSON.stringify(welcome))).toEqual(welcome);
    expect(decodeWhiteboardV1ServerFrame(JSON.stringify({ ...welcome, presenting: true }))).toEqual({ ...welcome, presenting: true });
  });

  it("accepts optional paired relay versions without changing legacy view frames", () => {
    const view = { type: "view", x: 1, y: 2, width: 300, height: 200, bring: false } as const;
    const version = { origin_participant_id: sceneId, origin_sequence: 7 };
    expect(JSON.parse(encodeWhiteboardV1ClientFrame(view))).toEqual(view);
    expect(JSON.parse(encodeWhiteboardV1ClientFrame({ ...view, ...version }))).toEqual({ ...view, ...version });
    const epoch = { origin_epoch: "20000000-0000-4000-8000-000000000002" };
    expect(JSON.parse(encodeWhiteboardV1ClientFrame({ ...view, ...version, ...epoch }))).toEqual({ ...view, ...version, ...epoch });
    const remote = { ...view, participant_id: sceneId, display_name: "Ada", occurred_at: "2026-10-21T00:00:00Z" };
    expect(decodeWhiteboardV1ServerFrame(JSON.stringify(remote))).toEqual(remote);
    expect(decodeWhiteboardV1ServerFrame(JSON.stringify({ ...remote, ...version }))).toEqual({ ...remote, ...version });
    expect(decodeWhiteboardV1ServerFrame(JSON.stringify({ ...remote, ...version, ...epoch }))).toEqual({ ...remote, ...version, ...epoch });
    expect(() => encodeWhiteboardV1ClientFrame({ ...view, origin_participant_id: sceneId })).toThrow();
    expect(() => encodeWhiteboardV1ClientFrame({ ...view, ...version, origin_sequence: 0 })).toThrow();
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
      encodeWhiteboardV1ClientFrame({
        type: "set_draw_permission",
        operation_id: "operation-000001",
        participant_session_id: sceneId,
        can_draw: true,
      }),
    ).toThrow();
  });
});
