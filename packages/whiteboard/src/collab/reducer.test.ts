import { describe, expect, it } from "vitest";
import { mergeWhiteboardElements } from "./reducer";
import type { WhiteboardWireElement } from "./wire";

const element = (id: string, index: string): WhiteboardWireElement => ({ id, type: "rectangle", version: 1, version_nonce: 1, index, is_deleted: false, payload: {} });

describe("mergeWhiteboardElements", () => {
  it("orders elements by the byte order of their order keys", () => {
    const merged = mergeWhiteboardElements([element("lower", "aa"), element("next", "ab")], [element("upper", "aA"), element("last", "aZ")]);

    expect(merged.map((item) => item.index)).toEqual(["aA", "aZ", "aa", "ab"]);
  });

  it("orders elements with the same order key by the byte order of their ids", () => {
    const merged = mergeWhiteboardElements([element("a", "ab")], [element("B", "ab")]);

    expect(merged.map((item) => item.id)).toEqual(["B", "a"]);
  });
});
