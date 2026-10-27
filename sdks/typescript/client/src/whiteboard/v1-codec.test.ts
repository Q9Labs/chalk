import { describe, expect, it } from "vitest";
import { decodeWhiteboardV1ServerFrame, decodeWhiteboardV1WireFrame, encodeWhiteboardV1ClientFrame } from "./v1-codec";

const sceneId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";

describe("whiteboard-v1 codec", () => {
  it("keeps negotiated drawing access internal while the public decoder stays 5.1 compatible", () => {
    const frame = { type: "draw_access", policy: "hosts", can_draw: false, capabilities: [], grants: [] };
    expect(decodeWhiteboardV1WireFrame(JSON.stringify(frame))).toEqual(frame);
    expect(() => decodeWhiteboardV1ServerFrame(JSON.stringify(frame))).toThrow();
  });

  it("negotiates owner input separately from canonical server sequences", () => {
    const hello = { type: "hello", protocol: "whiteboard-v1", token: "participant-token", cursor: null, extensions: [{ name: "presentation_v1" }, { name: "view_v1", origins: true, owner: true }] } as const;
    expect(JSON.parse(encodeWhiteboardV1ClientFrame(hello))).toEqual(hello);
    expect(JSON.parse(encodeWhiteboardV1ClientFrame({ ...hello, extensions: [...hello.extensions, { name: "draw_policy_v1" }] }))).toEqual({ ...hello, extensions: [...hello.extensions, { name: "draw_policy_v1" }] });
    const view = { type: "view", x: 0, y: 0, width: 100, height: 100, bring: false } as const;
    const input = { ...view, input_id: `${sceneId}:1`, move: true };
    expect(JSON.parse(encodeWhiteboardV1ClientFrame(input))).toEqual(input);
    expect(() => encodeWhiteboardV1ClientFrame({ ...view, owner_id: sceneId, owner_sequence: 99 })).toThrow();
    for (const input_id of [`${sceneId}:0`, `${sceneId}:01`, `${sceneId}:9007199254740992`, "not-a-stream:1"]) {
      expect(() => encodeWhiteboardV1ClientFrame({ ...input, input_id })).toThrow();
    }
    expect(() => decodeWhiteboardV1ServerFrame(JSON.stringify({ type: "view_ack", input_id: input.input_id }))).toThrow();
    expect(decodeWhiteboardV1WireFrame(JSON.stringify({ type: "view_ack", input_id: input.input_id }))).toEqual({ type: "view_ack", input_id: input.input_id });
    const canonical = { ...view, participant_id: sceneId, display_name: "Person", occurred_at: "2026-10-23T00:00:00Z", owner_id: sceneId, owner_sequence: 1 };
    expect(decodeWhiteboardV1ServerFrame(JSON.stringify(canonical))).toEqual(canonical);
    expect(() => decodeWhiteboardV1ServerFrame(JSON.stringify({ ...canonical, input_id: input.input_id, move: true }))).toThrow();
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

  it("negotiates the presentation opener without changing legacy frames", () => {
    const hello = { type: "hello", protocol: "whiteboard-v1", token: "participant-token", cursor: null, extensions: [{ name: "presentation_v1", presenter: true }] } as const;
    expect(JSON.parse(encodeWhiteboardV1ClientFrame(hello))).toEqual(hello);
    const presentation = { type: "presentation_updated", scene_id: sceneId, revision: "1", presenting: true, presenter_id: sceneId };
    expect(decodeWhiteboardV1ServerFrame(JSON.stringify(presentation))).toEqual(presentation);
    expect(() => decodeWhiteboardV1ServerFrame(JSON.stringify({ ...presentation, presenter_id: "invalid" }))).toThrow();
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
