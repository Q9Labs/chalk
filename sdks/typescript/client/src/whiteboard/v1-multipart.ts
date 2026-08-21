import { encodedWhiteboardV1FrameBytes, WhiteboardV1ProtocolLimits, type WhiteboardV1ClientFrame, type WhiteboardV1Element, type WhiteboardV1ServerFrame } from "../generated/whiteboard-v1";
import { encodeWhiteboardV1ClientFrame } from "./v1-codec";

export type WhiteboardV1LogicalOperationFrame = Extract<WhiteboardV1ClientFrame, { readonly type: "submit_update" | "clear" | "set_draw_permission" | "set_presentation" }>;

type SubmitUpdateFrame = Extract<WhiteboardV1LogicalOperationFrame, { readonly type: "submit_update" }>;
type SubmitUpdatePartFrame = Extract<WhiteboardV1ClientFrame, { readonly type: "submit_update_part" }>;
type UpdatePartFrame = Extract<WhiteboardV1ServerFrame, { readonly type: "update_part" }>;
type UpdateFrame = Extract<WhiteboardV1ServerFrame, { readonly type: "update" }>;

type UpdateAssembly = {
  readonly operationId: string;
  readonly sceneId: string;
  readonly revision: string;
  readonly partCount: number;
  readonly elementCount: number;
  readonly parts: Map<number, readonly WhiteboardV1Element[]>;
  bytes: number;
};

export type WhiteboardV1UpdateAssemblyResult = { readonly status: "incomplete"; readonly key: string; readonly started: boolean } | { readonly status: "complete"; readonly key: string; readonly frame: UpdateFrame };

export function whiteboardV1OperationFrames(frame: WhiteboardV1LogicalOperationFrame): readonly WhiteboardV1ClientFrame[] {
  if (frame.type !== "submit_update") {
    encodeWhiteboardV1ClientFrame(frame);
    return [frame];
  }

  if (validSingleFrame(frame)) return [frame];
  return multipartSubmitFrames(frame);
}

export function whiteboardV1PendingOperationBytes(frame: WhiteboardV1LogicalOperationFrame): number {
  return encodedWhiteboardV1FrameBytes(frame);
}

export class WhiteboardV1UpdateAssembler {
  readonly #assemblies = new Map<string, UpdateAssembly>();
  #bytes = 0;

  add(frame: UpdatePartFrame): WhiteboardV1UpdateAssemblyResult {
    const key = whiteboardV1UpdateAssemblyKey(frame);
    const existing = this.#assemblies.get(key);
    const started = existing === undefined;
    const assembly = existing ?? createAssembly(frame);

    assertConsistentPart(assembly, frame);
    if (!assembly.parts.has(frame.part)) {
      const partBytes = encodedWhiteboardV1FrameBytes(frame);
      assembly.parts.set(frame.part, frame.elements);
      assembly.bytes += partBytes;
      this.#bytes += partBytes;
    }
    if (assembly.bytes > WhiteboardV1ProtocolLimits.multipartUpdateMaxBytes || this.#bytes > WhiteboardV1ProtocolLimits.multipartUpdateMaxBytes) {
      this.clear();
      throw new Error("whiteboard multipart update exceeds byte capacity");
    }

    this.#assemblies.set(key, assembly);
    if (assembly.parts.size !== assembly.partCount) {
      return { status: "incomplete", key, started };
    }

    this.#delete(key);
    return { status: "complete", key, frame: completeAssembly(assembly) };
  }

  discard(key: string): void {
    this.#delete(key);
  }

  clear(): void {
    this.#assemblies.clear();
    this.#bytes = 0;
  }

  #delete(key: string): void {
    const assembly = this.#assemblies.get(key);
    if (!assembly) return;
    this.#assemblies.delete(key);
    this.#bytes -= assembly.bytes;
  }
}

export function whiteboardV1UpdateAssemblyKey(frame: Pick<UpdatePartFrame, "operation_id" | "scene_id" | "revision">): string {
  return `${frame.scene_id}:${frame.revision}:${frame.operation_id}`;
}

function validSingleFrame(frame: SubmitUpdateFrame): boolean {
  try {
    encodeWhiteboardV1ClientFrame(frame);
    return true;
  } catch {
    return false;
  }
}

function multipartSubmitFrames(frame: SubmitUpdateFrame): readonly SubmitUpdatePartFrame[] {
  if (frame.elements.length === 0 || frame.elements.length > WhiteboardV1ProtocolLimits.multipartUpdateMaxItems) {
    throw new Error("whiteboard multipart update exceeds element capacity");
  }

  const chunks = partitionElements(frame);
  if (chunks.length < 2 || chunks.length > WhiteboardV1ProtocolLimits.multipartUpdateMaxParts) {
    throw new Error("whiteboard multipart update exceeds part capacity");
  }

  const frames = chunks.map(
    (elements, part): SubmitUpdatePartFrame => ({
      type: "submit_update_part",
      operation_id: frame.operation_id,
      scene_id: frame.scene_id,
      sync_all: frame.sync_all,
      part,
      part_count: chunks.length,
      element_count: frame.elements.length,
      elements,
    }),
  );
  const bytes = frames.reduce((total, part) => total + encodedWhiteboardV1FrameBytes(part), 0);
  if (bytes > WhiteboardV1ProtocolLimits.multipartUpdateMaxBytes) {
    throw new Error("whiteboard multipart update exceeds byte capacity");
  }
  for (const part of frames) encodeWhiteboardV1ClientFrame(part);
  return frames;
}

function partitionElements(frame: SubmitUpdateFrame): readonly (readonly WhiteboardV1Element[])[] {
  const chunks: WhiteboardV1Element[][] = [];
  let current: WhiteboardV1Element[] = [];

  for (const element of frame.elements) {
    const candidate = [...current, element];
    if (current.length > 0 && !fitsMultipartFrame(frame, candidate)) {
      chunks.push(current);
      current = [element];
    } else {
      current = candidate;
    }
    if (!fitsMultipartFrame(frame, current)) {
      throw new Error("whiteboard element cannot fit in a multipart frame");
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function fitsMultipartFrame(frame: SubmitUpdateFrame, elements: readonly WhiteboardV1Element[]): boolean {
  if (elements.length > WhiteboardV1ProtocolLimits.elementBatchMaxItems) return false;
  const conservativeProbe: SubmitUpdatePartFrame = {
    type: "submit_update_part",
    operation_id: frame.operation_id,
    scene_id: frame.scene_id,
    sync_all: frame.sync_all,
    part: WhiteboardV1ProtocolLimits.multipartUpdateMaxParts - 1,
    part_count: WhiteboardV1ProtocolLimits.multipartUpdateMaxParts,
    element_count: frame.elements.length,
    elements,
  };
  return encodedWhiteboardV1FrameBytes(conservativeProbe) <= WhiteboardV1ProtocolLimits.decodedInboundFrameBytes;
}

function createAssembly(frame: UpdatePartFrame): UpdateAssembly {
  return {
    operationId: frame.operation_id,
    sceneId: frame.scene_id,
    revision: frame.revision,
    partCount: frame.part_count,
    elementCount: frame.element_count,
    parts: new Map(),
    bytes: 0,
  };
}

function assertConsistentPart(assembly: UpdateAssembly, frame: UpdatePartFrame): void {
  if (assembly.operationId !== frame.operation_id || assembly.sceneId !== frame.scene_id || assembly.revision !== frame.revision || assembly.partCount !== frame.part_count || assembly.elementCount !== frame.element_count) {
    throw new Error("inconsistent whiteboard multipart update");
  }
  const duplicate = assembly.parts.get(frame.part);
  if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(frame.elements)) {
    throw new Error("conflicting whiteboard multipart update part");
  }
}

function completeAssembly(assembly: UpdateAssembly): UpdateFrame {
  const elements: WhiteboardV1Element[] = [];
  for (let part = 0; part < assembly.partCount; part += 1) {
    const page = assembly.parts.get(part);
    if (!page) throw new Error("incomplete whiteboard multipart update");
    elements.push(...page);
  }
  if (elements.length !== assembly.elementCount) {
    throw new Error("whiteboard multipart element count mismatch");
  }
  return {
    type: "update",
    operation_id: assembly.operationId,
    scene_id: assembly.sceneId,
    revision: assembly.revision,
    elements,
  };
}
