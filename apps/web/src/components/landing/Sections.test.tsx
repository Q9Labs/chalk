import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FrontDoors, PerfBudget, SelfHost } from "./Sections";

describe("FrontDoors", () => {
  it("renders app and SDK entry points", () => {
    const markup = renderToStaticMarkup(<FrontDoors />);

    expect(markup).toContain("Start with the SDKs");
    expect(markup).toContain("Shape the whole room");
    expect(markup).toContain("@q9labsai/chalk-react");
    expect(markup).not.toContain("eyebrow");
  });
});

describe("PerfBudget", () => {
  it("renders the performance targets without presenting them as guarantees", () => {
    const markup = renderToStaticMarkup(<PerfBudget />);

    expect(markup).toContain("Click to media");
    expect(markup).toContain("Control signal");
    expect(markup).toContain("Glass to glass");
    expect(markup).toContain("not published production guarantees");
  });
});

describe("SelfHost", () => {
  it("renders the stack ownership points", () => {
    const markup = renderToStaticMarkup(<SelfHost />);

    expect(markup).toContain("Meeting surfaces");
    expect(markup).toContain("Portable core");
    expect(markup).toContain("Your infrastructure");
    expect(markup).toContain("future SFU adapter");
  });
});
