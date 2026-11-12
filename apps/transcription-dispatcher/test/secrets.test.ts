import { describe, expect, it } from "vitest";
import { loadDispatcherSecrets, type SsmParameterClient } from "../src/secrets.js";

type SsmAnswer = Awaited<ReturnType<SsmParameterClient["send"]>>;

function clientAnswering(answer: SsmAnswer, requests: string[][] = []): SsmParameterClient {
  return {
    send: async (command) => {
      requests.push(command.input.Names);
      return answer;
    },
  };
}

const names = { workloadAuth: "/chalk/workload", deepInfraToken: "/chalk/deepinfra", openRouterToken: "/chalk/openrouter", cloudflareAiToken: "/chalk/cloudflare" };

describe("loadDispatcherSecrets", () => {
  it("asks once for every requested name and returns each value under its slot", async () => {
    const requests: string[][] = [];
    const secrets = await loadDispatcherSecrets(
      clientAnswering(
        {
          Parameters: [
            { Name: "/chalk/workload", Value: "w" },
            { ARN: "/chalk/deepinfra", Value: "d" },
            { Name: "/chalk/openrouter", Value: "o" },
            { Name: "/chalk/cloudflare", Value: "c" },
          ],
        },
        requests,
      ),
      names,
    );
    expect(secrets).toEqual({ workloadAuth: "w", deepInfraToken: "d", openRouterToken: "o", cloudflareAiToken: "c" });
    expect(requests).toEqual([["/chalk/openrouter", "/chalk/workload", "/chalk/cloudflare", "/chalk/deepinfra"]]);
  });

  it("returns only the workload key when no provider is requested", async () => {
    const secrets = await loadDispatcherSecrets(clientAnswering({ Parameters: [{ Name: "/chalk/workload", Value: "w" }] }), { workloadAuth: "/chalk/workload" });
    expect(secrets).toEqual({ workloadAuth: "w" });
  });

  it.each([
    ["a wildcard name", { workloadAuth: "/chalk/*" }, { Parameters: [] }, "invalid SSM parameter ARN/name"],
    ["a name that is not a path or SSM ARN", { workloadAuth: "workload" }, { Parameters: [] }, "invalid SSM parameter ARN/name"],
    ["repeated names", { workloadAuth: "/chalk/a", deepInfraToken: "/chalk/a" }, { Parameters: [] }, "must be distinct"],
    ["an invalid parameter", { workloadAuth: "/chalk/workload" }, { InvalidParameters: ["/chalk/workload"] }, "parameter is unavailable"],
    ["an empty value", { workloadAuth: "/chalk/workload" }, { Parameters: [{ Name: "/chalk/workload", Value: "" }] }, "SSM returned an invalid parameter"],
    ["a parameter nobody asked for", { workloadAuth: "/chalk/workload" }, { Parameters: [{ Name: "/other", Value: "x" }] }, "unexpected parameter"],
    ["a duplicate parameter", { workloadAuth: "/chalk/workload" }, { Parameters: [{ Name: "/chalk/workload", Value: "a" }, { Name: "/chalk/workload", Value: "b" }] }, "duplicate parameter"],
    ["a missing workload key", { workloadAuth: "/chalk/workload", deepInfraToken: "/chalk/deepinfra" }, { Parameters: [{ Name: "/chalk/deepinfra", Value: "d" }] }, "required transcription secret is unavailable"],
    ["a missing DeepInfra token", { workloadAuth: "/chalk/workload", deepInfraToken: "/chalk/deepinfra" }, { Parameters: [{ Name: "/chalk/workload", Value: "w" }] }, "required DeepInfra secret is unavailable"],
    ["a missing OpenRouter token", { workloadAuth: "/chalk/workload", openRouterToken: "/chalk/openrouter" }, { Parameters: [{ Name: "/chalk/workload", Value: "w" }] }, "required OpenRouter secret is unavailable"],
  ])("rejects %s", async (_label, requested, answer, message) => {
    await expect(loadDispatcherSecrets(clientAnswering(answer), requested)).rejects.toThrow(message);
  });
});
