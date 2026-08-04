import { describe, expect, it } from "vitest";

import { resolveNativeTheme } from "./native-theme";

describe("resolveNativeTheme", () => {
  it("uses dark defaults while allowing semantic token overrides", () => {
    const theme = resolveNativeTheme({ tokens: { focus: "#f59e0b", positive: "#15803d" } });

    expect(theme.colorScheme).toBe("dark");
    expect(theme.colors.darkCanvas).toBe("#0a0a0b");
    expect(theme.colors.ring).toBe("#f59e0b");
    expect(theme.colors.success).toBe("#15803d");
  });
});
