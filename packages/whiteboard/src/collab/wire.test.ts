import { describe, expect, it } from "vitest";

import { fromWireElement, isWireElement, toWireElement } from "./wire";
import type { OrderedExcalidrawElement } from "./types";

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
        invalid: undefined,
      } as unknown as OrderedExcalidrawElement),
    ).toThrow("not JSON serializable");
  });
});
