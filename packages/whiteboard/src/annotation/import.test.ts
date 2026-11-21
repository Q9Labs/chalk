import type { ChalkWhiteboardV1UpdateInput, ScreenAnnotationMark, ScreenAnnotationShape } from "@q9labsai/chalk-client";
import { FRAME_UNITS, freezeAnnotationFrame } from "@q9labsai/chalk-screen-annotation";
import { generateKeyBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";

import { mergeWhiteboardElements } from "../collab/reducer";
import { fromWireElement, type WhiteboardWireElement } from "../collab/wire";
import { annotationWhiteboardPlacement, createAnnotationWhiteboardImport } from "./index";

const id = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
const id2 = "8fa459ea-ee8a-4ca4-894e-db77e160355e";
const origin = { x: 200, y: -118 };
const sceneId = "board-a";
const placement = { origin, afterIndex: "a0" };
const receipt = { sceneId, operationId: "receipt", revision: "3" };
const pristinePng = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const measureText = (line: string, size: number) => (line.length * size) / 2;

function point(x: number, y: number) {
  return { x: Math.round(x * FRAME_UNITS), y: Math.round(y * FRAME_UNITS) };
}

function mark(shape: ScreenAnnotationShape, revision: number): ScreenAnnotationMark {
  return {
    created_revision: revision,
    draft: { shape, mark_id: String(revision), lifetime: "keep", color: "#2266ff", width: 655 },
    author: { participant_id: "actor", display_name: "Alex", color: "#ff0000" },
    committed_at_ms: 1000,
    expires_at_ms: null,
  };
}

function frame(marks: readonly ScreenAnnotationMark[]) {
  return freezeAnnotationFrame({ image: pristinePng, size: { width: 1600, height: 900 }, marks, nowMs: 1000, publicationId: "screen" });
}

function wire(input: ChalkWhiteboardV1UpdateInput): WhiteboardWireElement[] {
  return input.elements.map(({ id, type, version, index, isDeleted, versionNonce, payload }) => ({ id, type, version, index, is_deleted: isDeleted, version_nonce: versionNonce, payload }));
}

describe("save a frame as editable whiteboard elements", () => {
  it("submits one image and every mark as editable data, placed at intrinsic scale", async () => {
    const line = { from_point: point(0.05, 0.1), to_point: point(0.28, 0.35) };
    const marks = [
      mark({ kind: "pen", points: [point(0.4, 0.2), point(0.1, 0.1)] }, 1),
      mark({ kind: "highlighter", points: [point(0.2, 0.6), point(0.4, 0.6)] }, 2),
      mark({ kind: "line", ...line }, 3),
      mark({ kind: "arrow", ...line }, 4),
      mark({ kind: "box", ...line }, 5),
      mark({ kind: "circle", ...line }, 6),
      mark({ kind: "text", at: point(0.1, 0.9), text: "A < B", note: true }, 7),
      mark({ kind: "stamp", at: point(0.26, 0.2), stamp: "cross" }, 8),
    ];
    const updates: ChalkWhiteboardV1UpdateInput[] = [];
    const uploads: { fileId: string; sceneId: string; png: Blob }[] = [];
    async function submitUpdate(input: ChalkWhiteboardV1UpdateInput) {
      updates.push(input);
      return receipt;
    }
    async function uploadFrame(input: (typeof uploads)[number]) {
      uploads.push(input);
    }
    const request = createAnnotationWhiteboardImport({ frame: frame(marks), sceneId, placement, importId: id, measureText, transport: { submitUpdate }, uploadFrame, encodeFrame: async (image) => image });
    expect(await request.save()).toEqual(receipt);
    expect(uploads).toEqual([{ fileId: `annotation-${id}`, sceneId, png: pristinePng }]);
    const [input] = updates;
    if (!input) throw new Error("No scene update");
    expect(updates).toHaveLength(1);
    expect(input).toMatchObject({ sceneId, syncAll: false });
    const elements = wire(input).map(fromWireElement);
    expect(elements.map((element) => element.type)).toEqual(["image", "freedraw", "freedraw", "line", "arrow", "rectangle", "ellipse", "rectangle", "text", "ellipse", "line", "line"]);
    expect(elements[0]).toMatchObject({ ...origin, width: 1600, height: 900, fileId: `annotation-${id}`, status: "saved", scale: [1, 1] });
    expect(elements[1]?.x).toBeCloseTo(origin.x + 0.4 * 1600, 1);
    expect(elements[1]?.y).toBeCloseTo(origin.y + 0.2 * 900, 1);
    expect(elements[2]?.opacity).toBe(36);
    expect(elements[4]).toMatchObject({ endArrowhead: "triangle" });
    expect(elements[8]).toMatchObject({ text: "A < B", originalText: "A < B", locked: false });
    expect(elements[8]?.groupIds).toEqual(elements[7]?.groupIds);
    expect(elements[11]?.groupIds).toEqual(elements[9]?.groupIds);
    expect(input.elements.every((element) => element.index > "a0")).toBe(true);
    const lastIndex = elements.at(-1)?.index ?? null;
    expect(annotationWhiteboardPlacement(elements, { x: 0, y: 0 })).toEqual({ origin: { x: 1848, y: -118 }, afterIndex: lastIndex });
    expect(generateKeyBetween(lastIndex, null) > (lastIndex ?? "")).toBe(true);
  });

  it("reuses the frozen bytes and element identities across unknown upload and commit outcomes", async () => {
    let uploads = 0;
    let updates = 0;
    let scene: readonly WhiteboardWireElement[] = [];
    let firstPayload: ChalkWhiteboardV1UpdateInput | undefined;
    let encodes = 0;
    async function encodeFrame(image: Blob) {
      encodes++;
      return image;
    }
    async function uploadFrame({ fileId, png }: { fileId: string; png: Blob }) {
      expect(fileId).toBe(`annotation-${id}`);
      expect(png).toBe(pristinePng);
      if (++uploads === 1) throw new Error("Lost upload response");
    }
    async function submitUpdate(input: ChalkWhiteboardV1UpdateInput) {
      scene = mergeWhiteboardElements(scene, wire(input));
      if (++updates === 1) {
        firstPayload = input;
        const originalMark = scene[1];
        if (!originalMark) throw new Error("No editable mark");
        // A board user can edit or delete the imported mark before the caller retries.
        scene = mergeWhiteboardElements(scene, [{ ...originalMark, is_deleted: true, version: 2 }]);
        throw new Error("Lost scene receipt");
      }
      expect(input).toEqual(firstPayload);
      return receipt;
    }
    const marks = [mark({ kind: "box", from_point: point(0.1, 0.1), to_point: point(0.2, 0.3) }, 1)];
    const request = createAnnotationWhiteboardImport({ frame: frame(marks), sceneId, placement, importId: id, measureText, transport: { submitUpdate }, uploadFrame, encodeFrame });
    const first = request.save();
    expect(request.save()).toBe(first);
    await expect(first).rejects.toThrow("Lost upload response");
    expect(scene).toHaveLength(0);
    await expect(request.save()).rejects.toThrow("Lost scene receipt");
    await expect(request.save()).resolves.toEqual(receipt);
    await expect(request.save()).resolves.toEqual(receipt);

    expect(encodes).toBe(1);
    expect(uploads).toBe(2);
    expect(updates).toBe(2);
    expect(scene).toHaveLength(2);
    expect(scene[1]).toMatchObject({ is_deleted: true, version: 2 });
  });

  it("gives simultaneous imports into the same board order disjoint keys", async () => {
    const indices: string[] = [];
    async function submitUpdate(input: ChalkWhiteboardV1UpdateInput) {
      for (const { index } of input.elements) indices.push(index);
      return receipt;
    }
    const options = { frame: frame([]), sceneId, placement, measureText, transport: { submitUpdate }, uploadFrame: async () => undefined, encodeFrame: async (image: Blob) => image };
    await Promise.all([createAnnotationWhiteboardImport({ ...options, importId: id }).save(), createAnnotationWhiteboardImport({ ...options, importId: id2 }).save()]);
    expect(new Set(indices).size).toBe(2);
  });
});
