import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LatencyVisual, StackVisual } from "./visuals";

describe("LatencyVisual", () => {
  it("renders the join funnel labels", () => {
    const markup = renderToStaticMarkup(<LatencyVisual />);

    expect(markup).toContain("Join funnel");
    expect(markup).toContain("First frame");
    expect(markup).toContain("under budget");
  });
});

describe("StackVisual", () => {
  it("renders the architecture layer labels", () => {
    const markup = renderToStaticMarkup(<StackVisual />);

    expect(markup).toContain("Front doors");
    expect(markup).toContain("Portable core");
    expect(markup).toContain("Your infra");
  });
});
