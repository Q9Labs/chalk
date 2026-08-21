import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Icon } from "./Icon";

describe("Icon", () => {
  it("hides repeated decorative artwork from assistive technology", () => {
    const markup = renderToStaticMarkup(<Icon glyph={Link01Icon} />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
  });
});
