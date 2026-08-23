import { describe, expect, it, vi } from "vitest";

import fixture from "./fixtures/excalidraw-0.18.1-reducer-golden.json";
import { mergeWhiteboardElements } from "./reducer";
import { filterSyncableElements } from "./syncable";
import { fromWireElement, isWireElement, toWireElement, type WhiteboardWireElement } from "./wire";
import type { OrderedExcalidrawElement } from "./types";

vi.mock("@excalidraw/excalidraw", () => ({
  isInvisiblySmallElement: (element: { width?: number; height?: number }) => element.width === 0 || element.height === 0,
}));

describe("whiteboard-v1 Excalidraw wire conversion", () => {
  it("round trips the pinned Excalidraw sync fields", () => {
    const element = {
      id: "rectangle-1",
      type: "rectangle",
      version: 3,
      versionNonce: 44,
      index: "a0",
      isDeleted: false,
      x: 12,
      y: 18,
    } as unknown as OrderedExcalidrawElement;

    const wire = toWireElement(element);
    expect(wire).toMatchObject({
      id: "rectangle-1",
      type: "rectangle",
      version: 3,
      version_nonce: 44,
      index: "a0",
      is_deleted: false,
    });
    expect(fromWireElement(wire)).toMatchObject(element);
  });

  it("rejects unknown envelope fields and non-JSON payloads", () => {
    expect(
      isWireElement({
        id: "rectangle-1",
        type: "rectangle",
        version: 3,
        version_nonce: 44,
        index: "a0",
        is_deleted: false,
        payload: {},
        unknown: true,
      }),
    ).toBe(false);

    expect(() =>
      toWireElement({
        id: "rectangle-1",
        type: "rectangle",
        version: 3,
        versionNonce: 44,
        index: "a0",
        isDeleted: false,
        invalid: () => undefined,
      } as unknown as OrderedExcalidrawElement),
    ).toThrow("not JSON serializable");
  });

  it("omits undefined optional Excalidraw properties from wire payloads", () => {
    const wire = toWireElement({
      id: "freedraw-1",
      type: "freedraw",
      version: 1,
      versionNonce: 2,
      index: "a0",
      isDeleted: false,
      customData: undefined,
      nested: { value: 1, optional: undefined },
    } as unknown as OrderedExcalidrawElement);

    expect(wire.payload).toMatchObject({ id: "freedraw-1", nested: { value: 1 } });
    expect(Object.hasOwn(wire.payload, "customData")).toBe(false);
    expect(Object.hasOwn(wire.payload.nested as object, "optional")).toBe(false);
  });
});

describe("whiteboard-v1 merge and sync filtering", () => {
  it("matches the pinned Excalidraw reducer and does not infer absent deletions", () => {
    const current: WhiteboardWireElement[] = fixture.current;
    const incoming: WhiteboardWireElement[] = fixture.incoming;

    expect(mergeWhiteboardElements(current, incoming)).toEqual(fixture.expected);
    expect(mergeWhiteboardElements(current, [])).toEqual(current);
  });

  it("keeps visible elements and server-authoritative tombstones", () => {
    const nowMs = Date.UTC(2026, 5, 14);
    const element = (id: string, isDeleted: boolean, updated: number, width: number, height: number) =>
      fromWireElement({ id, type: "rectangle", version: 1, version_nonce: 1, index: `a${id}`, is_deleted: isDeleted, payload: { updated, width, height } });
    const visible = element("visible", false, nowMs, 12, 12);
    const invisible = element("invisible", false, nowMs, 0, 12);
    const recentTombstone = element("recent", true, nowMs - 1000, 0, 0);
    const staleTombstone = element("stale", true, nowMs - 25 * 60 * 60 * 1000, 10, 10);

    expect(filterSyncableElements([visible, invisible, recentTombstone, staleTombstone])).toEqual([visible, recentTombstone, staleTombstone]);
  });
});
