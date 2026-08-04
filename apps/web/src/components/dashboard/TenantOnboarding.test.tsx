import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("Tenant onboarding contract", () => {
  it("resumes from authoritative Account and Tenant data before first Space", () => {
    const source = dashboardSource("TenantOnboarding.tsx");
    expect(source).toContain("getAccount(), listAllAccountTenants(), listRegions()");
    expect(source).toContain("await onboardTenant");
    expect(source).toContain("Create your first Space");
  });
});
