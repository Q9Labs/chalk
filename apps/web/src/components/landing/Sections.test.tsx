import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FrontDoors, PerfBudget, SelfHost } from "./Sections";

describe("FrontDoors", () => {
  it("renders app and SDK entry points", () => {
    const markup = renderToStaticMarkup(<FrontDoors />);

    expect(markup).toContain("The app");
    expect(markup).toContain("The SDK");
    expect(markup).toContain("@q9labsai/chalk-react");
  });
});

describe("PerfBudget", () => {
  it("renders the performance targets and latency visual", () => {
    const markup = renderToStaticMarkup(<PerfBudget />);

    expect(markup).toContain("Click to media target");
    expect(markup).toContain("sync");
    expect(markup).toContain("glass-to-glass");
  });
});

describe("SelfHost", () => {
  it("renders the stack ownership points", () => {
    const markup = renderToStaticMarkup(<SelfHost />);

    expect(markup).toContain("App-tier self-host source");
    expect(markup).toContain("Swappable media plane");
    expect(markup).toContain("Your identity, your tokens");
  });
});
