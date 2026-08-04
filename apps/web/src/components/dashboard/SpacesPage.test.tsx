import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpacesPage } from "./SpacesPage";

describe("Spaces index", () => {
  it("renders durable Spaces and current Episode state", () => {
    const markup = renderToStaticMarkup(<SpacesPage />);
    expect(markup).toContain("New Space");
    expect(markup).toContain("Current Episode");
    expect(markup).toContain("Product studio");
  });
});
