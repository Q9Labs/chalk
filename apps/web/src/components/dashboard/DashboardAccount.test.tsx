import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("protected Dashboard Account gate", () => {
  it("loads Account and authorized Tenants before honoring a Tenant hint", () => {
    const source = dashboardSource("DashboardAccount.tsx");
    expect(source).toContain("Promise.all([getAccount(), listAccountTenants()])");
    expect(source).toContain("state.tenants.some");
    expect(source).toContain('to: "/sign-in"');
  });
});
