import { describe, expect, it } from "vitest";
import { developerAction } from "../src/lib/dashboard/contracts";
import { configuration } from "./config";
const local = {
  CHALK_ENVIRONMENT: "local",
  CHALK_API_ORIGIN: "http://127.0.0.1:8788",
  DASHBOARD_ORIGIN: "http://localhost:8789",
  WORKOS_REDIRECT_URI: "http://localhost:8789/auth/callback",
  WORKOS_CLIENT_ID: "fixture-client",
  WORKOS_API_KEY: "fixture-key",
  WORKOS_COOKIE_PASSWORD: "fixture-cookie-password-at-least-32-characters",
  DASHBOARD_SERVICE_TOKEN: "fixture-service",
  DASHBOARD_IDENTITY_PROVIDER: "fixture",
};
describe("dashboard deployment boundary", () => {
  it("permits an explicitly local fixture with distinct HTTP cookies", () => {
    expect(configuration(local).DASHBOARD_IDENTITY_PROVIDER).toBe("fixture");
  });
  it.each(["staging", "production"])("rejects fixture mode in %s", (environment) => {
    expect(() => configuration({ ...local, CHALK_ENVIRONMENT: environment, CHALK_API_ORIGIN: "https://api.example.test", DASHBOARD_ORIGIN: "https://chalk.example.test", WORKOS_REDIRECT_URI: "https://chalk.example.test/auth/callback" })).toThrow("Fixture identity is local/test only");
  });
  it("rejects non-loopback insecure local origins", () => {
    expect(() => configuration({ ...local, DASHBOARD_ORIGIN: "http://shared.example.test", WORKOS_REDIRECT_URI: "http://shared.example.test/auth/callback" })).toThrow("Local HTTP must use loopback");
  });
  it("rejects an external callback", () => {
    expect(() => configuration({ ...local, WORKOS_REDIRECT_URI: "https://evil.example/auth/callback" })).toThrow("fixed dashboard callback");
  });
});

describe("allowed websites boundary", () => {
  it("keeps the dashboard origin when clearing or deduplicating websites", () => {
    expect(developerAction.parse({ action: "set-allowed-websites", origins: [] })).toEqual({ action: "set-allowed-websites", origins: ["https://chalkmeet.com"] });
    expect(developerAction.parse({ action: "set-allowed-websites", origins: ["https://EXAMPLE.test", "https://example.test", "http://localhost:80", "http://localhost:3000"] })).toEqual({
      action: "set-allowed-websites",
      origins: ["https://chalkmeet.com", "https://example.test", "http://localhost:80", "http://localhost:3000"],
    });
  });
  it.each(["http://example.test:8080", "http://localhost", "http://127.0.0.1:3000", "http://localhost:65536", "https://user@example.test", "https://example.test/path", "https://example.test?query", "https://example.test#fragment", "https://example.test/\n"])(
    "rejects non-origin or disallowed website %s",
    (origin) => {
      expect(developerAction.safeParse({ action: "set-allowed-websites", origins: [origin] }).success).toBe(false);
    },
  );
  it("reserves one of the API's 32 origins for chalkmeet.com", () => {
    const origins = Array.from({ length: 32 }, (_, index) => `https://site${index}.test`);
    expect(developerAction.safeParse({ action: "set-allowed-websites", origins }).success).toBe(false);
    expect(developerAction.safeParse({ action: "set-allowed-websites", origins: origins.slice(1) }).success).toBe(true);
  });
});
