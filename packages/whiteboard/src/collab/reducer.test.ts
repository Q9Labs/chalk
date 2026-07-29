import { describe, expect, it } from "vitest";

import fixture from "./fixtures/excalidraw-0.18.1-reducer-golden.json";
import { mergeWhiteboardElements } from "./reducer";
import type { WhiteboardWireElement } from "./wire";

describe("whiteboard-v1 deterministic reducer", () => {
  it("matches the Excalidraw 0.18.1 golden merge", () => {
    expect(mergeWhiteboardElements(fixture.current as WhiteboardWireElement[], fixture.incoming as WhiteboardWireElement[])).toEqual(fixture.expected);
  });

  it("does not infer deletions from absent elements in a full sync", () => {
    expect(mergeWhiteboardElements(fixture.current as WhiteboardWireElement[], [])).toEqual(fixture.current);
  });
});
