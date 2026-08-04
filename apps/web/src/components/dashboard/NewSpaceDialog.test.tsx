import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NewSpaceDialog } from "./NewSpaceDialog";

describe("new Space dialog", () => {
  it("explains the durable Space model without forcing Developer setup", () => {
    const markup = renderToStaticMarkup(<NewSpaceDialog open={false} onClose={() => undefined} />);
    expect(markup).toContain("recurring Episodes and shared context");
    expect(markup).toContain("Everyone in the Tenant");
    expect(markup).not.toContain("API key");
  });
});
