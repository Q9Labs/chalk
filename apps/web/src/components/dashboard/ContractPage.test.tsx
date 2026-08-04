import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContractPage } from "./ContractPage";

describe("preview contract page", () => {
  it("labels unsupported Developer behavior as preview", () => {
    const markup = renderToStaticMarkup(<ContractPage kind="developer" />);
    expect(markup).toContain("Developer");
    expect(markup).toContain("Data and mutations remain fixture-backed");
  });
});
