import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("Account page contract", () => {
  it("keeps the Dashboard Account distinct and exposes real sign-out", () => {
    const source = dashboardSource("AccountPage.tsx");
    expect(source).toContain("Chalk sign-in stays separate");
    expect(source).toContain("await signOut()");
  });
});
