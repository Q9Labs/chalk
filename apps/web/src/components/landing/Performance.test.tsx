import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Performance } from "./Performance";

describe("Performance", () => {
  it("states the latency budgets and keeps the caveat out of the headline", () => {
    const markup = renderToStaticMarkup(<Performance />);

    expect(markup).toContain('id="speed"');
    expect(markup).toContain("Every step on the way in ");
    expect(markup).toContain("has a number it has to beat.");
    expect(markup).toContain("&lt;1s");
    expect(markup).toContain("&lt;100ms");
    expect(markup).toContain("&lt;200ms");
    expect(markup).toContain("not a published service level agreement");
    expect(markup).not.toContain("<h2>These are the budgets");
  });

  it("tints each budget differently so the three read as separate numbers", () => {
    const markup = renderToStaticMarkup(<Performance />);

    expect(markup).toContain("speed-stat-blue");
    expect(markup).toContain("speed-stat-green");
    expect(markup).toContain("speed-stat-yellow");
  });
});
