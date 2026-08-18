import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Illustration } from "./Illustration";

describe("Illustration", () => {
  it("keeps abstract landing art decorative and lazy by default", () => {
    const markup = renderToStaticMarkup(<Illustration src="/images/landing/example.webp" width={1200} height={800} />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('alt=""');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
  });

  it("eagerly loads art used above the fold", () => {
    const markup = renderToStaticMarkup(<Illustration src="/images/landing/example.webp" width={1200} height={800} priority />);

    expect(markup).toContain('loading="eager"');
    expect(markup).toContain('fetchPriority="high"');
  });
});
