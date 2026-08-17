import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Closing } from "./Closing";

describe("Closing", () => {
  it("closes on the two front doors and nothing else", () => {
    const markup = renderToStaticMarkup(<Closing />);

    // The chalked half of the line sits in its own element, so the headline
    // never appears in the markup as one contiguous string.
    expect(markup).toContain("Give every conversation ");
    expect(markup).toContain("a place to live.");
    expect(markup).toContain("Create an account");
    expect(markup).toContain("Explore the SDK");
    expect(markup).toContain('href="/sign-up"');
    expect(markup).toContain('href="/sdk-preview"');
    expect(markup).not.toContain("Under active development");
  });

  it("keeps the section anchors and legal pages reachable from the footer", () => {
    const markup = renderToStaticMarkup(<Closing />);

    expect(markup).toContain('href="#product"');
    expect(markup).toContain('href="#spaces"');
    expect(markup).toContain('href="/home"');
    expect(markup).toContain('href="/sign-in"');
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('href="/terms"');
  });
});
