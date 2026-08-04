import { describe, expect, it } from "vitest";

import { ChalkProvider, useSpaceClient } from "./space-client-context";

describe("ChalkProvider", () => {
  it("provides the canonical SpaceClient context entry", () => {
    expect(ChalkProvider).toBeTypeOf("function");
    expect(useSpaceClient).toBeTypeOf("function");
  });
});
