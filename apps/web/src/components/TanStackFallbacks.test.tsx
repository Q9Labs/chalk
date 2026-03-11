import { describe, expect, it } from "vitest";

import { ErrorComponent, NotFoundComponent, PendingComponent } from "./TanStackFallbacks";

describe("TanStackFallbacks", () => {
  it("exports the shared route fallback components", () => {
    expect(PendingComponent).toBeTypeOf("function");
    expect(ErrorComponent).toBeTypeOf("function");
    expect(NotFoundComponent).toBeTypeOf("function");
  });
});
