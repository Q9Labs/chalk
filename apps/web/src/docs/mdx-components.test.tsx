/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Callout, CardGrid, DocsLink, FeatureCard, InlineCode, CodeBlock } from "../components/docs/primitives";
import { MDX_COMPONENTS } from "./mdx-components";

afterEach(cleanup);

describe("MDX components", () => {
  it("maps MDX tags to the docs presentation primitives", () => {
    expect(MDX_COMPONENTS.a).toBe(DocsLink);
    expect(MDX_COMPONENTS.code).toBe(InlineCode);
    expect(MDX_COMPONENTS.pre).toBe(CodeBlock);
    expect(MDX_COMPONENTS.Callout).toBe(Callout);
    expect(MDX_COMPONENTS.CardGrid).toBe(CardGrid);
    expect(MDX_COMPONENTS.FeatureCard).toBe(FeatureCard);
  });

  it("renders links and inline code through the mapped components", () => {
    render(
      <>
        <MDX_COMPONENTS.a href="/docs/quickstart">Quickstart</MDX_COMPONENTS.a>
        <MDX_COMPONENTS.code>space.join()</MDX_COMPONENTS.code>
      </>,
    );

    expect(screen.getByRole("link", { name: "Quickstart" }).getAttribute("href")).toBe("/docs/quickstart");
    expect(screen.getByText("space.join()").className).toContain("docs-inline-code");
  });
});
