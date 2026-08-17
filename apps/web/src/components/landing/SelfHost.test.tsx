import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SelfHost } from "./SelfHost";

describe("SelfHost", () => {
  it("claims only what the deployment actually supports today", () => {
    const markup = renderToStaticMarkup(<SelfHost />);

    expect(markup).toContain('id="self-host"');
    expect(markup).toContain("The parts you would want to replace ");
    expect(markup).toContain("are the parts we made replaceable.");
    expect(markup).toContain("standard Postgres is enough");
    expect(markup).toContain("You hold the signing keys.");
    expect(markup).toContain("needs an adapter that is not finished");
  });

  it("ticks every claim and singles out the swappable tier in the diagram", () => {
    const markup = renderToStaticMarkup(<SelfHost />);

    expect(markup.match(/stack-claims/g)).toHaveLength(1);
    expect(markup.match(/sd-layer-seam/g)).toHaveLength(1);
  });
});
