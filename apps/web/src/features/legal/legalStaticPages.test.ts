import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVACY_POLICY_DOCUMENT, TERMS_OF_SERVICE_DOCUMENT } from "./legalDocuments";
import { renderLegacyPrivacyPolicyRedirectPage, renderStaticLegalPage } from "./staticLegalPages";

describe("static legal pages", () => {
  it("keeps the privacy static page in sync with the canonical source", () => {
    const page = readFileSync(resolve(process.cwd(), "public/privacy/index.html"), "utf8");
    expect(page).toBe(renderStaticLegalPage(PRIVACY_POLICY_DOCUMENT));
  });

  it("keeps the terms static page in sync with the canonical source", () => {
    const page = readFileSync(resolve(process.cwd(), "public/terms/index.html"), "utf8");
    expect(page).toBe(renderStaticLegalPage(TERMS_OF_SERVICE_DOCUMENT));
  });

  it("keeps the legacy privacy-policy redirect in sync", () => {
    const page = readFileSync(resolve(process.cwd(), "public/privacy-policy/index.html"), "utf8");
    expect(page).toBe(renderLegacyPrivacyPolicyRedirectPage());
  });
});
