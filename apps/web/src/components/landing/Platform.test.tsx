import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Platform } from "./Platform";

describe("Platform", () => {
  it("groups shipped capabilities instead of listing progress badges", () => {
    const markup = renderToStaticMarkup(<Platform />);

    expect(markup).toContain('id="platform"');
    expect(markup).toContain("Space and identity");
    expect(markup).toContain("Realtime sync");
    expect(markup).toContain("Media");
    expect(markup).toContain("SDK surfaces");
    expect(markup).toContain("Operations");
    expect(markup).not.toContain(">In progress<");
    expect(markup).not.toContain(">Planned<");
  });

  it("names the unfinished work once, in fine print", () => {
    const markup = renderToStaticMarkup(<Platform />);

    expect(markup).toContain("Still being qualified:");
    expect(markup).toContain("a self-hosted SFU adapter");
  });
});
