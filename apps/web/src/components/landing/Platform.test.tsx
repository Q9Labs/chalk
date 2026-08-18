import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Platform } from "./Platform";

describe("Platform", () => {
  it("distills shipped capabilities into four working systems", () => {
    const markup = renderToStaticMarkup(<Platform />);

    expect(markup).toContain('id="platform"');
    expect(markup).toContain("Twenty-eight shipped capabilities");
    expect(markup).toContain("Space and access");
    expect(markup).toContain("Realtime and media");
    expect(markup).toContain("SDK surfaces");
    expect(markup).toContain("Operations");
    expect(markup.match(/capability-group card/g)).toHaveLength(4);
    expect(markup).toContain("/images/landing/chalk-flow-platform-20260818.webp");
    expect(markup).not.toContain("chip-groups");
    expect(markup).not.toContain(">In progress<");
    expect(markup).not.toContain(">Planned<");
  });

  it("names the unfinished work once, in fine print", () => {
    const markup = renderToStaticMarkup(<Platform />);

    expect(markup).toContain("Still being qualified:");
    expect(markup).toContain("a self-hosted SFU adapter");
  });
});
