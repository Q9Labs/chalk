// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Facehash } from "../index";

describe("Facehash", () => {
  it("renders the expected web SVG structure", () => {
    const markup = renderToStaticMarkup(<Facehash colors={["#f97316", "#ea580c", "#2a1209"]} enableBlink interactive={false} name="Hasan" size={64} />);

    expect(markup).toContain("data-facehash");
    expect(markup).toContain('viewBox="0 0 100 100"');
    expect(markup).toContain("radialGradient");
    expect(markup).toContain('font-family="monospace"');
    expect(markup).toContain(">H</text>");
  });
});
