import { describe, expect, it } from "vitest";

import { ErrorComponent, NotFoundComponent, PendingComponent } from "./TanStackFallbacks";

describe("TanStackFallbacks", () => {
  it("exports the shared route fallback components", () => {
    expect(PendingComponent).toBeDefined();
    expect(ErrorComponent).toBeDefined();
    expect(NotFoundComponent).toBeDefined();

    // React.memo exports are component objects (not plain functions).
    expect((PendingComponent as { $$typeof?: symbol }).$$typeof).toBeTypeOf("symbol");
    expect((ErrorComponent as { $$typeof?: symbol }).$$typeof).toBeTypeOf("symbol");
    expect((NotFoundComponent as { $$typeof?: symbol }).$$typeof).toBeTypeOf("symbol");
  });
});
