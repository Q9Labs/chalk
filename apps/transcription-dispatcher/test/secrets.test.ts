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

const names = { workloadAuth: "/chalk/workload", openRouterToken: "/chalk/openrouter" };

describe("loadDispatcherSecrets", () => {
  it("asks once for every requested name and returns each value under its slot", async () => {
    const requests: string[][] = [];
    const secrets = await loadDispatcherSecrets(
      clientAnswering(
        {
          Parameters: [
            { Name: "/chalk/workload", Value: "w" },
            { ARN: "/chalk/openrouter", Value: "o" },
          ],
        },
        requests,
      ),
      names,
    );
    expect(secrets).toEqual({ workloadAuth: "w", openRouterToken: "o" });
    expect(requests).toEqual([["/chalk/openrouter", "/chalk/workload"]]);
  });

  it.each([
    ["a wildcard name", { ...names, workloadAuth: "/chalk/*" }, { Parameters: [] }, "invalid SSM parameter ARN/name"],
    ["a name that is not a path or SSM ARN", { ...names, workloadAuth: "workload" }, { Parameters: [] }, "invalid SSM parameter ARN/name"],
    ["repeated names", { ...names, workloadAuth: names.openRouterToken }, { Parameters: [] }, "must be distinct"],
    ["an invalid parameter", names, { InvalidParameters: ["/chalk/workload"] }, "parameter is unavailable"],
    ["an empty value", names, { Parameters: [{ Name: "/chalk/workload", Value: "" }] }, "SSM returned an invalid parameter"],
    ["a parameter nobody asked for", names, { Parameters: [{ Name: "/other", Value: "x" }] }, "unexpected parameter"],
    [
      "a duplicate parameter",
      names,
      {
        Parameters: [
          { Name: "/chalk/workload", Value: "a" },
          { Name: "/chalk/workload", Value: "b" },
        ],
      },
      "duplicate parameter",
    ],
    ["a missing workload key", names, { Parameters: [{ Name: "/chalk/openrouter", Value: "o" }] }, "required transcription secret is unavailable"],
    ["a missing OpenRouter token", names, { Parameters: [{ Name: "/chalk/workload", Value: "w" }] }, "required OpenRouter secret is unavailable"],
  ])("rejects %s", async (_label, requested, answer, message) => {
    await expect(loadDispatcherSecrets(clientAnswering(answer), requested)).rejects.toThrow(message);
  });
});
