import { describe, expect, it } from "vitest";
import { secretParameterNames } from "../src/config.js";

const base = { CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN: "/chalk/workload" };

describe("secretParameterNames", () => {
  it("requests OpenRouter and workload keys even on an environment with legacy Whisper switches", () => {
    expect(
      secretParameterNames({
        ...base,
        DEEPINFRA_ENABLED: "true",
        DEEPINFRA_TOKEN_PARAMETER_ARN: "/chalk/deepinfra",
        OPENROUTER_TOKEN_PARAMETER_ARN: "/chalk/openrouter",
      }),
    ).toEqual({ workloadAuth: "/chalk/workload", openRouterToken: "/chalk/openrouter" });
  });

  it("fails before fetching secrets when OpenRouter is not configured", () => {
    expect(() => secretParameterNames(base)).toThrow("OPENROUTER_TOKEN_PARAMETER_ARN");
  });
});
