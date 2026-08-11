import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("dashboard shell contract", () => {
  it("keeps Developer secondary to the collaboration product", () => {
    const source = dashboardSource("DashboardShell.tsx");
    expect(source.indexOf('label: "Spaces"')).toBeLessThan(source.indexOf('label: "Developer"'));
    expect(source).toContain('aria-label="Switch Tenant"');
    expect(source).toContain('aria-label="Open navigation"');
    expect(source).toContain("Skip to dashboard content");
    expect(source).toContain('event.key.toLowerCase() !== "n"');
  });
});
