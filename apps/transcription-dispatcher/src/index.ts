import { MaiTranscribeProvider } from "./mai-provider.js";
import { loadReleaseConfig, required, secretParameterNames } from "./config.js";
import { RecorderControlApiClient } from "./control-api.js";
import { createLambdaHandler } from "./dispatcher.js";
import { CloudflareWhisperProvider, DeepInfraWhisperProvider } from "./providers.js";
import { loadDispatcherSecrets, type DispatcherSecrets, type SsmParameterClient } from "./secrets.js";
import { HmacWorkloadSigner } from "./workload-auth.js";
import type { DispatcherEvent } from "./types.js";

let cachedHandler: ReturnType<typeof createLambdaHandler> | undefined;

export function buildHandler(env: NodeJS.ProcessEnv = process.env, secrets?: DispatcherSecrets): ReturnType<typeof createLambdaHandler> {
  const config = loadReleaseConfig(env, secrets);
  const fetchImpl = globalThis.fetch;
  if (!fetchImpl) throw new Error("Fetch API is unavailable");
  const signer = new HmacWorkloadSigner({ secret: required(secrets?.workloadAuth, "CONTROL_API_WORKLOAD_AUTH_SECRET"), environment: config.environment, releaseId: config.releaseId, audience: config.controlApiAudience });
  const control = new RecorderControlApiClient({ baseUrl: config.controlApiBaseUrl, signer, fetch: fetchImpl });
  const fallback = config.cloudflare.enabled
    ? new CloudflareWhisperProvider({
        fetch: fetchImpl,
        token: config.cloudflare.token,
        accountId: config.cloudflare.accountId,
        modelSlug: config.cloudflare.modelSlug,
        policy: config.provider,
        adapterContractVersion: config.cloudflare.adapterContractVersion,
      })
    : undefined;
  const primary = config.deepInfra.enabled
    ? new DeepInfraWhisperProvider({
        fetch: fetchImpl,
        token: required(config.deepInfra.token, "DeepInfra token"),
        versionContract: required(config.deepInfra.adapterContractVersion, "DeepInfra adapter contract"),
        ...(config.deepInfra.executionIdentityPin ? { executionIdentityPin: config.deepInfra.executionIdentityPin } : {}),
        ...(config.deepInfra.modelVersionPin ? { modelVersionPin: config.deepInfra.modelVersionPin } : {}),
        policy: config.provider,
      })
    : undefined;
  return createLambdaHandler({
    config,
    control,
    ...(config.codeswitchProvider === "mai" ? { codeswitch: new MaiTranscribeProvider({ fetch: fetchImpl, token: required(config.openRouterToken, "OpenRouter token"), policy: config.provider }) } : {}),
    ...(primary === undefined ? {} : { primary }),
    ...(fallback ? { fallback } : {}),
    fetch: fetchImpl,
    logger: {
      info: (event, fields) => console.info(event, fields ?? {}),
      warn: (event, fields) => console.warn(event, fields ?? {}),
    },
  });
}

export async function buildHandlerFromSsm(env: NodeJS.ProcessEnv, client: SsmParameterClient): Promise<ReturnType<typeof createLambdaHandler>> {
  const secrets = await loadDispatcherSecrets(client, secretParameterNames(env));
  return buildHandler(env, secrets);
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
