import { loadReleaseConfig } from "./config.js";
import { RecorderControlApiClient } from "./control-api.js";
import { createLambdaHandler } from "./dispatcher.js";
import { CloudflareWhisperProvider, DeepInfraWhisperProvider } from "./providers.js";
import { loadDispatcherSecrets, type DispatcherSecrets, type SsmParameterClient } from "./secrets.js";
import { HmacWorkloadSigner } from "./workload-auth.js";
import type { DispatcherEvent, ReleaseConfig } from "./types.js";

export * from "./canary.js";
export * from "./cleanup.js";
export * from "./config.js";
export * from "./control-api.js";
export * from "./dispatcher.js";
export * from "./errors.js";
export * from "./finalizer.js";
export * from "./normalize.js";
export * from "./providers.js";
export * from "./provider-utils.js";
export * from "./retry.js";
export * from "./storage.js";
export * from "./secrets.js";
export * from "./types.js";
export * from "./urls.js";
export * from "./workload-auth.js";

let cachedHandler: ReturnType<typeof createLambdaHandler> | undefined;

export function buildHandler(env: NodeJS.ProcessEnv = process.env, secrets?: DispatcherSecrets): ReturnType<typeof createLambdaHandler> {
  const config = loadReleaseConfig(env, secrets);
  const fetchImpl = globalThis.fetch;
  if (!fetchImpl) throw new Error("Fetch API is unavailable");
  const signer = new HmacWorkloadSigner({ secret: required(secrets?.workloadAuth, "CONTROL_API_WORKLOAD_AUTH_SECRET"), environment: config.environment, releaseId: config.releaseId, audience: config.controlApiAudience });
  const control = new RecorderControlApiClient({ baseUrl: config.controlApiBaseUrl, signer, fetch: fetchImpl });
  const fallback = new CloudflareWhisperProvider({
    fetch: fetchImpl,
    token: config.cloudflare.token,
    accountId: config.cloudflare.accountId,
    modelSlug: config.cloudflare.modelSlug,
    policy: config.provider,
    adapterContractVersion: config.cloudflare.adapterContractVersion,
  });
  const primary = config.deepInfra.enabled
    ? new DeepInfraWhisperProvider({
        fetch: fetchImpl,
        token: config.deepInfra.token as string,
        executionIdentityPin: config.deepInfra.executionIdentityPin as string,
        modelVersionPin: config.deepInfra.modelVersionPin as string,
        policy: config.provider,
      })
    : undefined;
  return createLambdaHandler({
    config,
    control,
    ...(primary === undefined ? {} : { primary }),
    fallback,
    fetch: fetchImpl,
  });
}

export async function buildHandlerFromSsm(env: NodeJS.ProcessEnv, client: SsmParameterClient): Promise<ReturnType<typeof createLambdaHandler>> {
  const deepInfraEnabled = env.DEEPINFRA_ENABLED === "true";
  const secrets = await loadDispatcherSecrets(client, {
    ...(deepInfraEnabled ? { deepInfraToken: requiredEnv(env, "DEEPINFRA_TOKEN_PARAMETER_ARN") } : {}),
    cloudflareAiToken: requiredEnv(env, "CLOUDFLARE_AI_TOKEN_PARAMETER_ARN"),
    workloadAuth: requiredEnv(env, "CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN"),
  });
  return buildHandler(env, secrets);
}

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`missing required configuration: ${key}`);
  return value;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  return required(env[key], key);
}

export const handler = async (event: DispatcherEvent, context: { getRemainingTimeInMillis(): number }) => {
  cachedHandler ??= await buildHandlerFromSsm(process.env, await createAwsSsmParameterClient());
  return cachedHandler(event, context);
};

async function createAwsSsmParameterClient(): Promise<SsmParameterClient> {
  const sdk = await import("@aws-sdk/client-ssm");
  const client = new sdk.SSMClient({});
  return {
    send: async (command) => client.send(new sdk.GetParametersCommand(command.input)),
  };
}
