import { describe, expect, it } from "vitest";
import { EpisodeDiagnosticsConfigError, HOSTED_EPISODE_DIAGNOSTICS_GATEWAY_CONTRACT, isLoopbackHostname, resolveEpisodeDiagnosticsConfig } from "./episode-diagnostics-config";

describe("resolveEpisodeDiagnosticsConfig", () => {
  it.each([
    ["off", "production", false],
    ["off", "localhost", false],
    ["localhost", "localhost", true],
    ["hosted", "development", true],
    ["hosted", "staging", true],
  ] as const)("accepts %s in %s", (mode, environment, enabled) => {
    expect(resolveEpisodeDiagnosticsConfig(mode, environment, mode === "hosted" ? "verified" : undefined)).toEqual({
      enabled,
      mode,
      environment,
    });
  });

  it("accepts hosted diagnostics in production only with the exact opt-in", () => {
    expect(resolveEpisodeDiagnosticsConfig("hosted", "production", "verified", "true")).toEqual({
      enabled: true,
      mode: "hosted",
      environment: "production",
    });
  });

  it("defaults to the fail-closed production configuration", () => {
    expect(resolveEpisodeDiagnosticsConfig(undefined, undefined)).toEqual({
      enabled: false,
      mode: "off",
      environment: "production",
    });
  });

  it.each([
    ["sometimes", "localhost"],
    ["localhost", "development"],
    ["localhost", "production"],
    ["hosted", "localhost"],
    ["hosted", "production"],
    ["off", "preview"],
  ])("refuses mode %s in environment %s", (mode, environment) => {
    expect(() => resolveEpisodeDiagnosticsConfig(mode, environment)).toThrow(EpisodeDiagnosticsConfigError);
  });

  it("rejects production localhost mode even with the exact hosted opt-in", () => {
    expect(() => resolveEpisodeDiagnosticsConfig("localhost", "production", undefined, "true")).toThrow(EpisodeDiagnosticsConfigError);
  });

  it.each([undefined, "false", "TRUE", "1", " true "])("rejects production hosted mode without the exact opt-in: %s", (productionOptIn) => {
    expect(() => resolveEpisodeDiagnosticsConfig("hosted", "production", "verified", productionOptIn)).toThrow("CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN=true");
  });

  it("preserves hosted configuration errors after the production opt-in", () => {
    expect(() => resolveEpisodeDiagnosticsConfig("hosted", "production", undefined, "true")).toThrow("CHALK_EPISODE_DIAGNOSTICS_GATEWAY=verified");
  });

  it("refuses hosted mode until the environment gateway is explicitly verified", () => {
    expect(() => resolveEpisodeDiagnosticsConfig("hosted", "staging")).toThrow("CHALK_EPISODE_DIAGNOSTICS_GATEWAY=verified");
  });
});

describe("hosted gateway contract", () => {
  it("keeps bearer authorization out of browser code and assigns injection to the environment gateway", () => {
    expect(HOSTED_EPISODE_DIAGNOSTICS_GATEWAY_CONTRACT).toMatchObject({
      path: "/_internal/episode-diagnostics",
      configuration: "CHALK_EPISODE_DIAGNOSTICS_GATEWAY=verified",
      browserCredentials: "same-origin",
      browserAuthorizationHeader: false,
      gatewayAuthorizationHeader: "authorization",
    });
  });
});

describe("isLoopbackHostname", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("accepts %s", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each(["0.0.0.0", "chalk.test", "192.168.1.4"])("rejects %s", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });
});
