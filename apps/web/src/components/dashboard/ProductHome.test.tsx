import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("product Home contract", () => {
  it("separates Space management from joining without fake business metrics", () => {
    const source = dashboardSource("ProductHome.tsx");
    expect(source).toContain("Continue where you left off");
    expect(source).toContain("Open Spaces");
    expect(source).toContain("listEpisodes");
    expect(source).toContain("View details");
    expect(source).toContain("Join Space");
    expect(source).toContain("dashboardSpaceHref");
    expect(source).toContain("Open history");
    expect(source).toContain("episodeHistoryHref");
    expect(source).toContain("ActivityChart");
    expect(source).toContain("home-summary");
    expect(source).toContain("Live now");
    expect(source).toContain("!state && !error");
    expect(source).not.toContain('from "./dashboard-data"');
    expect(source).not.toContain('className="eyebrow"');
    expect(source).not.toMatch(/revenue|conversion|monthly active|API usage/iu);
  });
});
