import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpaceModel } from "./SpaceModel";

describe("SpaceModel", () => {
  it("separates the durable Space from the bounded Episode", () => {
    const markup = renderToStaticMarkup(<SpaceModel />);

    expect(markup).toContain('id="spaces"');
    expect(markup).toContain("Nobody should re-invite the same six people ");
    expect(markup).toContain("every Tuesday.");
    expect(markup).toContain("A Space is the durable place");
    expect(markup).toContain("An Episode is one bounded run");
    expect(markup).toContain("One link, for good");
    expect(markup).toContain("Episodes start themselves");
    expect(markup).toContain("What ended stays ended");
  });

  it("draws the Episode timeline above the points it illustrates", () => {
    const markup = renderToStaticMarkup(<SpaceModel />);

    expect(markup).toContain("/images/landing/chalk-flow-episodes-20260818.webp");
    expect(markup).toContain("tl-rail");
    expect(markup).toContain("Stays in the Space, between all of them");
    expect(markup.indexOf("chalk-flow-episodes")).toBeLessThan(markup.indexOf("tl-rail"));
    expect(markup.indexOf("tl-rail")).toBeLessThan(markup.indexOf("One link, for good"));
  });

  it("keeps the timeline decorative, since the points beneath it carry the claim", () => {
    const markup = renderToStaticMarkup(<SpaceModel />);

    expect(markup).toContain('<figure class="tl" aria-hidden="true">');
  });
});
