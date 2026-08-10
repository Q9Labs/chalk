import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("product Home contract", () => {
  it("centers continuation and Quick join instead of operational metrics", () => {
    const source = dashboardSource("ProductHome.tsx");
    expect(source).toContain("Continue where you left off");
    expect(source).toContain("Browse Spaces");
    expect(source).toContain("listEpisodes");
    expect(source).toContain("Open Space");
    expect(source).toContain("Open history");
    expect(source).toContain("episodeHistoryHref");
    expect(source).toContain("!state && !error");
    expect(source).not.toContain('from "./dashboard-data"');
    expect(source).not.toMatch(/revenue|conversion|monthly active|API usage/iu);
  });
});
