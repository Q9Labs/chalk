import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("Tenant settings contract", () => {
  it("shows authorized Tenant facts without unsupported controls", () => {
    const source = dashboardSource("TenantSettingsPage.tsx");
    expect(source).toContain("current.access.role");
    expect(source).toContain("Settings remain read-only");
  });
});
