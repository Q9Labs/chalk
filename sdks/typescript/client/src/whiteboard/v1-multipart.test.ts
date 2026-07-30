import { describe, expect, it } from "vitest";
import { encodedWhiteboardV1FrameBytes, WhiteboardV1ProtocolLimits, type WhiteboardV1Element } from "../generated/whiteboard-v1";
import { WhiteboardV1UpdateAssembler, whiteboardV1OperationFrames } from "./v1-multipart";

const operationId = "operation-0000000001";
const sceneId = "10000000-0000-4000-8000-000000000001";

describe("whiteboard-v1 multipart updates", () => {
  it("partitions above both the item and frame byte limits", () => {
    const byItems = operationFrames(Array.from({ length: 129 }, (_, index) => element(index)));
    expect(byItems).toHaveLength(2);
    expect(byItems.every((frame) => frame.type === "submit_update_part")).toBe(true);
    expect(byItems.map((frame) => frame.elements.length)).toEqual([128, 1]);

    const byBytes = operationFrames(Array.from({ length: 30 }, (_, index) => element(index, "x".repeat(12_000))));
    expect(byBytes.length).toBeGreaterThan(1);
    expect(byBytes.every((frame) => encodedWhiteboardV1FrameBytes(frame) <= WhiteboardV1ProtocolLimits.decodedInboundFrameBytes)).toBe(true);
    expect(byBytes.flatMap((frame) => frame.elements)).toHaveLength(30);
  });

  it("assembles an atomic update in part order and ignores an exact duplicate", () => {
    const parts = operationFrames(Array.from({ length: 129 }, (_, index) => element(index)));
    const assembler = new WhiteboardV1UpdateAssembler();
    const last = toUpdatePart(parts[1]!, "7");
    const first = toUpdatePart(parts[0]!, "7");

    expect(assembler.add(last)).toMatchObject({ status: "incomplete", started: true });
    expect(assembler.add(last)).toMatchObject({ status: "incomplete", started: false });
    const completed = assembler.add(first);

    expect(completed).toMatchObject({
      status: "complete",
      frame: {
        type: "update",
        operation_id: operationId,
        scene_id: sceneId,
        revision: "7",
      },
    });
    if (completed.status === "complete") {
      expect(completed.frame.elements.map((item) => item.id)).toEqual(Array.from({ length: 129 }, (_, index) => `element-${index}`));
    }
  });

  it("round-trips a 1,000-element full sync without losing groups, styles, or tombstones", () => {
    const elements = Array.from({ length: 1_000 }, (_, index) => ({
      ...element(index),
      is_deleted: index % 17 === 0,
      payload: {
        content: `label-${index}`,
        groupIds: [`group-${Math.floor(index / 10)}`],
        strokeColor: index % 2 === 0 ? "#1e1e1e" : "#e03131",
      },
    }));
    const parts = operationFrames(elements);
    const assembler = new WhiteboardV1UpdateAssembler();
    const reversed = [...parts].reverse();

    expect(parts).toHaveLength(8);
    let result = assembler.add(toUpdatePart(reversed[0]!, "42"));
    for (const part of reversed.slice(1)) result = assembler.add(toUpdatePart(part, "42"));

    expect(result).toMatchObject({ status: "complete", frame: { revision: "42", elements } });
  });

  it("rejects a conflicting duplicate without exposing a partial update", () => {
    const parts = operationFrames(Array.from({ length: 129 }, (_, index) => element(index)));
    const assembler = new WhiteboardV1UpdateAssembler();
    const first = toUpdatePart(parts[0]!, "7");

    expect(assembler.add(first)).toMatchObject({ status: "incomplete" });
    expect(() =>
      assembler.add({
        ...first,
        elements: [element(999)],
      }),
    ).toThrow("conflicting whiteboard multipart update part");
  });
});

function operationFrames(elements: readonly WhiteboardV1Element[]) {
  const frames = whiteboardV1OperationFrames({
    type: "submit_update",
    operation_id: operationId,
    scene_id: sceneId,
    sync_all: true,
    elements,
  });
  return frames.filter((frame) => frame.type === "submit_update_part");
}

function toUpdatePart(frame: ReturnType<typeof operationFrames>[number], revision: string) {
  return {
    type: "update_part",
    operation_id: frame.operation_id,
    scene_id: frame.scene_id,
    revision,
    part: frame.part,
    part_count: frame.part_count,
    element_count: frame.element_count,
    elements: frame.elements,
  } as const;
}

function element(index: number, content = "value"): WhiteboardV1Element {
  return {
    id: `element-${index}`,
    type: "rectangle",
    version: 1,
    version_nonce: index,
    index: `a${index}`,
    is_deleted: false,
    payload: { content },
  };
}
