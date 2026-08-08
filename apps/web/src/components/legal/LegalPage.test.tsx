/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LegalPage } from "./LegalPage";

afterEach(cleanup);

describe("LegalPage", () => {
  it("renders the privacy policy with a real cookie table and heading hierarchy", () => {
    render(<LegalPage kind="privacy" />);

    expect(screen.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cookies", level: 2 })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });

  it("keeps the privacy policy link inside the terms prose", () => {
    render(<LegalPage kind="terms" />);

    expect(screen.getByRole("heading", { name: "Terms of Service", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
  });
});
