import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Chalked } from "./Chalked";

describe("Chalked", () => {
  it("renders the text with a decorative underline", () => {
    const markup = renderToStaticMarkup(<Chalked>meeting surface</Chalked>);

    expect(markup).toContain("meeting surface");
    expect(markup).toContain('aria-hidden="true"');
  });
});
