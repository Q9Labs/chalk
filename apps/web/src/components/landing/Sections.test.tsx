import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FrontDoors, PerfBudget, SelfHost } from "./Sections";

describe("FrontDoors", () => {
  it("renders product, join, and SDK entry points", () => {
    const markup = renderToStaticMarkup(<FrontDoors />);

    expect(markup).toContain('id="product"');
    expect(markup).toContain("Manage and create");
    expect(markup).toContain("Join a Space");
    expect(markup).toContain("Build your product");
    expect(markup).toContain("Create an Account");
    expect(markup).toContain('href="#join-space"');
    expect(markup).toContain('href="/sdk-preview"');
    expect(markup).toContain("Tenant");
    expect(markup).toContain("Episode");
    expect(markup).toContain("Participant");
    expect(markup).not.toContain("section-kicker");
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

    expect(markup).toContain("Space surfaces");
    expect(markup).toContain("Portable core");
    expect(markup).toContain("Your infrastructure");
    expect(markup).toContain("future SFU adapter");
  });
});
