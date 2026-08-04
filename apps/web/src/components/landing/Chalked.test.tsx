import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Chalked } from "./Chalked";

describe("Chalked", () => {
  it("renders the text with a decorative underline", () => {
    const markup = renderToStaticMarkup(<Chalked>Space surface</Chalked>);

    expect(markup).toContain("Space surface");
    expect(markup).toContain('aria-hidden="true"');
  });
});
