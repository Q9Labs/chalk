import { MaiTranscribeProvider } from "./mai-provider.js";
import { loadReleaseConfig, required, secretParameterNames } from "./config.js";
import { createKernel } from "./obs/kernel.js";
import { ENVIRONMENTS, type Environment } from "./obs/registry.js";
import { RecorderControlApiClient } from "./control-api.js";
import { createLambdaHandler } from "./dispatcher.js";
import { CloudflareWhisperProvider, DeepInfraWhisperProvider } from "./providers.js";
import { loadDispatcherSecrets, type DispatcherSecrets, type SsmParameterClient } from "./secrets.js";
import { createWorkloadSigner } from "./workload-auth.js";
import type { DispatcherEvent } from "./types.js";

let cachedHandler: ReturnType<typeof createLambdaHandler> | undefined;

export function buildHandler(env: NodeJS.ProcessEnv = process.env, secrets?: DispatcherSecrets): ReturnType<typeof createLambdaHandler> {
  const config = loadReleaseConfig(env, secrets);
  const fetchImpl = globalThis.fetch;
  if (!fetchImpl) throw new Error("Fetch API is unavailable");
  const signer = createWorkloadSigner({ secret: required(secrets?.workloadAuth, "CONTROL_API_WORKLOAD_AUTH_SECRET"), environment: config.environment, releaseId: config.releaseId, audience: config.controlApiAudience });
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
  const logger = {
    info: (event: string, fields?: Record<string, string | number | boolean>) => console.info(event, fields ?? {}),
    warn: (event: string, fields?: Record<string, string | number | boolean>) => console.warn(event, fields ?? {}),
  };
  const environment = ENVIRONMENTS.includes(config.environment as Environment) ? (config.environment as Environment) : "local";
  const obs = createKernel({
    // The sink is one JSON line per record: `console.info(name, fields)` in dev (the local-run harness appends
    // dispatcher.jsonl) and the same two-argument shape in Lambda's CloudWatch logs.
    sink: (record) => logger.info(record.name, { ...record }),
    build: { module: "transcription_dispatcher", env: environment, platform: "lambda", release_sha: config.releaseId },
    mode: process.env.CHALK_OBS_MODE === "closed" || process.env.VITEST !== undefined ? "closed" : "open",
  });
  return createLambdaHandler({
    config,
    control,
    ...(config.codeswitchProvider === "mai" ? { codeswitch: new MaiTranscribeProvider({ fetch: fetchImpl, token: required(config.openRouterToken, "OpenRouter token"), policy: config.provider }) } : {}),
    ...(primary === undefined ? {} : { primary }),
    ...(fallback ? { fallback } : {}),
    fetch: fetchImpl,
    logger,
    obs,
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
