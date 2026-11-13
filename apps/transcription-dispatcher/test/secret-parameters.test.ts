import { describe, expect, it } from "vitest";
import { secretParameterNames } from "../src/config.js";

const base = {
  CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN: "/chalk/workload",
  DEEPINFRA_ENABLED: "false",
  CLOUDFLARE_AI_ENABLED: "false",
};

describe("secretParameterNames", () => {
  it("asks SSM only for the providers the release switches on", () => {
    expect(secretParameterNames(base)).toEqual({ workloadAuth: "/chalk/workload" });
    expect(secretParameterNames({ ...base, DEEPINFRA_ENABLED: "true", DEEPINFRA_TOKEN_PARAMETER_ARN: "/chalk/deepinfra", CODESWITCH_PROVIDER: "mai", OPENROUTER_TOKEN_PARAMETER_ARN: "/chalk/openrouter" })).toEqual({
      workloadAuth: "/chalk/workload",
      deepInfraToken: "/chalk/deepinfra",
      openRouterToken: "/chalk/openrouter",
    });
  });

  it("fails on a switch that is on without its parameter, or a provider that is not release-qualified", () => {
    expect(() => secretParameterNames({ ...base, CLOUDFLARE_AI_ENABLED: "true" })).toThrow("CLOUDFLARE_AI_TOKEN_PARAMETER_ARN");
    expect(() => secretParameterNames({ ...base, CODESWITCH_PROVIDER: "other" })).toThrow("not release-qualified");
  });
});
