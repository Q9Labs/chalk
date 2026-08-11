import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Closing, FeatureGrid } from "./Closing";

describe("FeatureGrid", () => {
  it("renders capabilities without progress badges", () => {
    const markup = renderToStaticMarkup(<FeatureGrid />);

    expect(markup).toContain("Space core");
    expect(markup).toContain("Recording");
    expect(markup).toContain("Whiteboard");
    expect(markup).toContain("Webhooks");
    expect(markup).not.toContain(">Implemented<");
    expect(markup).not.toContain(">In progress<");
  });
});

describe("Closing", () => {
  it("links to dashboard and account actions", () => {
    const markup = renderToStaticMarkup(<Closing />);

    expect(markup).toContain("Create an Account");
    expect(markup).toContain("Open Dashboard");
    expect(markup).toContain("Sign in");
    expect(markup).toContain('href="/home"');
    expect(markup).toContain('href="/sign-up"');
    expect(markup).toContain('href="/sign-in"');
    expect(markup).toContain('href="#product"');
    expect(markup).toContain("Under active development");
    expect(markup).not.toContain('href="/sdk-preview"');
  });
});
