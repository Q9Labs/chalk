import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("dashboard shell contract", () => {
  it("keeps the skip link and the Space creation shortcut on the shell", () => {
    const source = dashboardSource("DashboardShell.tsx");
    expect(source).toContain("Skip to dashboard content");
    expect(source).toContain('href="#dashboard-content"');
    expect(source).toContain('id="dashboard-content"');
    expect(source).toContain('event.key.toLowerCase() !== "n"');
  });
});
