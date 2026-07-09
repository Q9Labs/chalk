import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Closing, FeatureGrid } from "./Closing";

describe("FeatureGrid", () => {
  it("renders the included meeting capabilities", () => {
    const markup = renderToStaticMarkup(<FeatureGrid />);

    expect(markup).toContain("Recordings");
    expect(markup).toContain("Whiteboard");
    expect(markup).toContain("Webhooks");
  });
});

describe("Closing", () => {
  it("renders primary calls to action and legal links", () => {
    const markup = renderToStaticMarkup(<Closing />);

    expect(markup).toContain("Start a meeting");
    expect(markup).toContain("Embed the SDK");
    expect(markup).toContain("Status");
    expect(markup).toContain("Privacy");
  });
});
