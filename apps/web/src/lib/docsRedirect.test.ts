import { describe, expect, it } from "vitest";
import { DOCS_BASE_URL, getDocsExternalUrl, isLegacyDocsPath } from "./docsRedirect";

describe("docsRedirect", () => {
  it("maps /docs to the external docs root", () => {
    expect(getDocsExternalUrl("/docs")).toBe(DOCS_BASE_URL);
  });

  it("preserves nested docs paths, search, and hash", () => {
    expect(getDocsExternalUrl("/docs/getting-started", "?tab=react", "#install")).toBe(`${DOCS_BASE_URL}/getting-started?tab=react#install`);
  });

  it("treats /documentation as a legacy docs path", () => {
    expect(isLegacyDocsPath("/documentation")).toBe(true);
    expect(isLegacyDocsPath("/documentation/sdk-react")).toBe(true);
    expect(getDocsExternalUrl("/documentation")).toBe(DOCS_BASE_URL);
  });

  it("ignores unrelated paths", () => {
    expect(isLegacyDocsPath("/room/abc")).toBe(false);
  });
});
