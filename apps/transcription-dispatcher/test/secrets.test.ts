import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/errors.js";
import { loadDispatcherSecrets } from "../src/secrets.js";

const workloadArn = "arn:aws:ssm:us-east-1:123456789012:parameter/chalk/production/workload";
const deepInfraArn = "arn:aws:ssm:us-east-1:123456789012:parameter/chalk/production/deepinfra";

describe("dispatcher SSM secrets", () => {
  it("binds ARN requests to the returned ARN when SSM names are parameter paths", async () => {
    const secrets = await loadDispatcherSecrets(
      {
        send: async (command) => {
          expect(command.input.Names).toEqual([workloadArn, deepInfraArn]);
          return {
            Parameters: [
              { Name: "/chalk/production/deepinfra", ARN: deepInfraArn, Value: "deepinfra-token" },
              { Name: "/chalk/production/workload", ARN: workloadArn, Value: "workload-key" },
            ],
          };
        },
      },
      { workloadAuth: workloadArn, deepInfraToken: deepInfraArn },
    );

    expect(secrets).toEqual({ workloadAuth: "workload-key", deepInfraToken: "deepinfra-token" });
  });

  it("binds parameter-name requests to returned names", async () => {
    const secrets = await loadDispatcherSecrets(
      {
        send: async () => ({
          Parameters: [
            { Name: "/chalk/production/workload", Value: "workload-key" },
            { Name: "/chalk/production/deepinfra", Value: "deepinfra-token" },
          ],
        }),
      },
      { workloadAuth: "/chalk/production/workload", deepInfraToken: "/chalk/production/deepinfra" },
    );

    expect(secrets).toEqual({ workloadAuth: "workload-key", deepInfraToken: "deepinfra-token" });
  });

  it("does not assign one response to both an ARN and path alias", async () => {
    await expect(
      loadDispatcherSecrets(
        {
          send: async () => ({
            Parameters: [{ Name: "/chalk/production/workload", ARN: workloadArn, Value: "workload-key" }],
          }),
        },
        { workloadAuth: workloadArn, deepInfraToken: "/chalk/production/workload" },
      ),
    ).rejects.toEqual(new ConfigError("required DeepInfra secret is unavailable"));
  });

  it.each([
    ["an unexpected parameter", [{ Name: "/chalk/production/other", Value: "other" }], "SSM returned an unexpected parameter"],
    [
      "a duplicate parameter",
      [
        { Name: "/chalk/production/workload", Value: "first" },
        { Name: "/chalk/production/workload", Value: "second" },
      ],
      "SSM returned a duplicate parameter",
    ],
    ["a parameter without an identity", [{ Value: "workload-key" }], "SSM returned an invalid parameter"],
    ["a parameter without a value", [{ Name: "/chalk/production/workload" }], "SSM returned an invalid parameter"],
  ])("rejects %s", async (_scenario, parameters, message) => {
    await expect(loadDispatcherSecrets({ send: async () => ({ Parameters: parameters }) }, { workloadAuth: "/chalk/production/workload" })).rejects.toEqual(new ConfigError(message));
  });

  it("rejects a missing required parameter", async () => {
    await expect(loadDispatcherSecrets({ send: async () => ({ Parameters: [] }) }, { workloadAuth: "/chalk/production/workload" })).rejects.toEqual(new ConfigError("required transcription secret is unavailable"));
  });
});
