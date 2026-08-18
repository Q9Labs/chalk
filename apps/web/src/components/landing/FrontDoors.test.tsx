import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FrontDoors } from "./FrontDoors";

describe("FrontDoors", () => {
  it("gives the product and the SDK distinct doors", () => {
    const markup = renderToStaticMarkup(<FrontDoors />);

    expect(markup).toContain('id="product"');
    expect(markup).toContain("Sign in, ");
    expect(markup).toContain("or npm install.");
    expect(markup).toContain("Use Chalk");
    expect(markup).toContain("Build on Chalk");
    // Two cards on shared subgrid rows, so the pair reads as a comparison.
    expect(markup.match(/bento-card/g)).toHaveLength(2);
    expect(markup).toContain("chalk.q9labs.ai/space/");
    expect(markup).toContain('href="/sign-up"');
    expect(markup).toContain('href="/home"');
    expect(markup).toContain('href="/sdk-preview"');
    expect(markup).toContain("/images/landing/chalk-flow-hosted-20260818.webp");
    expect(markup).toContain("/images/landing/chalk-flow-sdk-20260818.webp");
  });

  it("shows the real SDK entry point and never mints access in the browser", () => {
    const markup = renderToStaticMarkup(<FrontDoors />);

    expect(markup).toContain("@q9labsai/chalk-react");
    expect(markup).toContain("getAccess={requestGrant}");
    expect(markup).toContain("Browser code never mints access.");
  });
});
