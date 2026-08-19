/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DocsFooter } from "./DocsFooter";

afterEach(cleanup);

describe("DocsFooter", () => {
  it("publishes the Chalk identity and footer destinations", () => {
    render(<DocsFooter />);

    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Chalk" }).getAttribute("href")).toBe("/");
    expect(screen.getByText("Real-time collaboration and communication for durable Spaces.")).toBeTruthy();

    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/docs");
    expect(screen.getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/privacy");
    expect(screen.getByRole("link", { name: "Terms" }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: "Status" }).getAttribute("href")).toBe("/status");
  });
});
