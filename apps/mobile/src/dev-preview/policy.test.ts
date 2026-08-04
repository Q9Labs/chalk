import { describe, expect, it } from "vitest";

import { canOpenDevPreviewFromRoute, canShowGlobalDiagnostics, isDevPreviewRuntime, isProductionMobileBuild, resolveMobileBuildProfile } from "./policy";

describe("native SDK preview policy", () => {
  it("keeps local and preview profiles enabled by default", () => {
    expect(resolveMobileBuildProfile()).toBe("development");
    expect(resolveMobileBuildProfile({ appVariant: "development" })).toBe("development");
    expect(resolveMobileBuildProfile({ appVariant: "preview" })).toBe("preview");
    expect(isProductionMobileBuild({ appVariant: "preview" })).toBe(false);
    expect(isProductionMobileBuild({ appVariant: "development", easBuildProfile: "preview" })).toBe(false);
  });

  it("lets the EAS profile take precedence over the app variant", () => {
    expect(resolveMobileBuildProfile({ appVariant: "development", easBuildProfile: "production" })).toBe("production");
    expect(isProductionMobileBuild({ appVariant: "preview", easBuildProfile: "production" })).toBe(true);
  });

  it("uses NODE_ENV as a production fallback only when no mobile profile is set", () => {
    expect(isProductionMobileBuild({ nodeEnv: "production" })).toBe(true);
    expect(isProductionMobileBuild({ appVariant: "development", nodeEnv: "production" })).toBe(false);
    expect(isProductionMobileBuild({ easBuildProfile: "preview", nodeEnv: "production" })).toBe(false);
  });

  it("requires the JavaScript development flag at runtime", () => {
    expect(isDevPreviewRuntime(true)).toBe(true);
    expect(isDevPreviewRuntime(false)).toBe(false);
  });

  it("does not replace a live Space route from a warm preview link", () => {
    expect(canOpenDevPreviewFromRoute("home")).toBe(true);
    expect(canOpenDevPreviewFromRoute("sdk-preview")).toBe(true);
    expect(canOpenDevPreviewFromRoute("lobby")).toBe(false);
  });

  it("keeps the global diagnostics launcher off the gallery", () => {
    expect(canShowGlobalDiagnostics("home")).toBe(true);
    expect(canShowGlobalDiagnostics("lobby")).toBe(true);
    expect(canShowGlobalDiagnostics("sdk-preview")).toBe(false);
  });
});
