/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DOCS_PAGES } from "../../docs/manifest";
import { DocsArticle } from "./DocsArticle";

describe("DocsArticle", () => {
  it("renders the landing page content, quickstart action, and heading outline", async () => {
    const page = DOCS_PAGES.find((candidate) => candidate.slug === "");
    if (!page) throw new Error("Why Chalk page is missing from the docs manifest");

    render(<DocsArticle page={page} />);

    expect(screen.getByRole("heading", { name: "Why Chalk", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Start with Quickstart/ }).getAttribute("href")).toBe("/docs/quickstart");
    expect(await screen.findByRole("heading", { name: "Chalk makes live work durable", level: 2 }, { timeout: 20_000 })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "On this page" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /NextQuickstart/ }).getAttribute("href")).toBe("/docs/quickstart");
  }, 30_000);
});
