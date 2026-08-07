// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EpisodeDiagnosticsDeveloperLink } from "./EpisodeDiagnosticsDeveloperLink";
import { TEST_REFERENCE } from "./test-fixtures";

afterEach(cleanup);

describe("EpisodeDiagnosticsDeveloperLink", () => {
  it("is absent when diagnostics are compile-gated off", () => {
    const { container } = render(<EpisodeDiagnosticsDeveloperLink diagnosticReference={TEST_REFERENCE} enabled={false} />);
    expect(container.childElementCount).toBe(0);
  });

  it("links only an authoritative canonical Diagnostic Reference", () => {
    render(<EpisodeDiagnosticsDeveloperLink diagnosticReference={TEST_REFERENCE} enabled />);
    expect(screen.getByRole("link", { name: "Open Episode Debugger" }).getAttribute("href")).toContain(encodeURIComponent(TEST_REFERENCE));
  });
});
