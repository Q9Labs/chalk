import type { ScreenAnnotationState } from "@q9labsai/chalk-client";
import type { AnnotationPresence } from "@q9labsai/chalk-screen-annotation";
import { expect, it } from "vitest";
import { paintAnnotationPiP } from "./pip-paint";

it("renders the viewer's colored ink and named cursor, but not after pause or expiry", () => {
  const viewer = { participant_id: "viewer", display_name: "Omar", color: "#e39b39" };
  const state: ScreenAnnotationState = {
    layer: { layer_id: "layer", publication_id: "share", sharer_id: "sharer", frame: { width: 1440, height: 900 } },
    fence: 1,
    revision: 1,
    paused: false,
    access: { can_draw: true, can_moderate: true, can_manage_policy: true, default_color: "#fff", draw_policy: "everyone", requests: [] },
    marks: [
      {
        author: viewer,
        created_revision: 1,
        committed_at_ms: 10,
        expires_at_ms: 2000,
        draft: {
          mark_id: "mark",
          color: "#43dd8b",
          width: 300,
          lifetime: "fade",
          shape: { kind: "line", from_point: { x: 0, y: 0 }, to_point: { x: 65535, y: 65535 } },
        },
      },
    ],
  };
  const presence: AnnotationPresence[] = [{ author: viewer, draft: null, server_at_ms: 10, expires_at_ms: 1000, cursor: { tool: "ink", point: { x: 16000, y: 16000 } } }];
  const rect = { x: 0, y: 0, width: 480, height: 300 };

  const ink = paintAnnotationPiP(rect, state, presence, 20);
  expect(ink).toContainEqual([
    "stroke",
    "#43dd8b",
    1,
    [
      ["move", 0, 0],
      ["line", 480, 300],
    ],
    expect.any(Number),
    "round",
  ]);
  expect(ink).toContainEqual(["fill", viewer.color, 1, expect.any(Array)]);
  expect(ink).toContainEqual(["text", "#0b0b0d", 1, viewer.display_name, expect.any(Number), expect.any(Number), expect.any(Number)]);
  expect(paintAnnotationPiP(rect, { ...state, paused: true }, presence, 20)).toEqual([]);
  expect(paintAnnotationPiP(rect, state, presence, 2000)).toEqual([]);
});
