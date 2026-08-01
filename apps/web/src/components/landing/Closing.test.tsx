import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Closing, FeatureGrid } from "./Closing";

describe("FeatureGrid", () => {
  it("renders capabilities with honest implementation status", () => {
    const markup = renderToStaticMarkup(<FeatureGrid />);

    expect(markup).toContain("Meeting core");
    expect(markup).toContain("Recording");
    expect(markup).toContain("Whiteboard");
    expect(markup).toContain("Webhooks");
    expect(markup).toContain("Implemented");
    expect(markup).toContain("In progress");
  });
});

describe("Closing", () => {
  it("links to implemented preview content", () => {
    const markup = renderToStaticMarkup(<Closing />);

    expect(markup).toContain("View SDK preview");
    expect(markup).toContain("Explore the SDKs");
    expect(markup).toContain("Under active development");
    expect(markup).not.toContain('href="/new"');
  });
});
