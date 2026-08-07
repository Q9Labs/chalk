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
