import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpaceLinkCard, SpaceTimeline } from "./visuals";

describe("SpaceLinkCard", () => {
  it("shows one durable Space link with its members and surfaces", () => {
    const markup = renderToStaticMarkup(<SpaceLinkCard />);

    expect(markup).toContain("chalk.q9labs.ai/space/");
    expect(markup).toContain("design-lab");
    expect(markup).toContain("Copy link");
    expect(markup).toContain("Whiteboard");
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("SpaceTimeline", () => {
  it("lays Episodes on a shared Space rail and marks the live one", () => {
    const markup = renderToStaticMarkup(<SpaceTimeline />);

    expect(markup).toContain("Space · design-lab");
    expect(markup).toContain("Design review");
    expect(markup).toContain("tl-episode-live");
    expect(markup).toContain("Transcript");
    expect(markup).toContain("Whiteboard");
    expect(markup).toContain("Stays in the Space, between all of them");
  });

  it("stays decorative, since the prose beside it carries the claim", () => {
    const markup = renderToStaticMarkup(<SpaceTimeline />);

    expect(markup).toContain('aria-hidden="true"');
  });
});
