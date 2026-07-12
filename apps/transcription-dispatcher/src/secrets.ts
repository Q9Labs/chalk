import { ConfigError } from "./errors.js";

export interface SsmParameterClient {
  send(command: {
    input: {
      Names: string[];
      WithDecryption: true;
    };
  }): Promise<{
    Parameters?: Array<{ Name?: string; Value?: string }>;
    InvalidParameters?: string[];
  }>;
}

export interface DispatcherSecrets {
  deepInfraToken?: string;
  cloudflareAiToken: string;
  workloadAuth: string;
}

export interface SecretParameterNames {
  deepInfraToken?: string;
  cloudflareAiToken: string;
  workloadAuth: string;
}

/**
 * Reads exactly the three environment-scoped SSM parameters declared by IaC.
 * Values are returned to the caller for process-memory use and are never logged,
 * serialized, or retained by this loader.
 */
export async function loadDispatcherSecrets(client: SsmParameterClient, names: SecretParameterNames): Promise<DispatcherSecrets> {
  const requested = [names.cloudflareAiToken, names.workloadAuth, ...(names.deepInfraToken ? [names.deepInfraToken] : [])];
  if (requested.some((name) => !validParameterName(name))) throw new ConfigError("invalid SSM parameter ARN/name");
  if (new Set(requested).size !== requested.length) throw new ConfigError("SSM parameter names must be distinct");
  const response = await client.send({ input: { Names: requested, WithDecryption: true } });
  if (response.InvalidParameters?.length) throw new ConfigError("required transcription SSM parameter is unavailable");
  const values = new Map((response.Parameters ?? []).flatMap((parameter) => (parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value] as const] : [])));
  if ([...values.keys()].some((name) => !requested.includes(name))) throw new ConfigError("SSM returned an unexpected parameter");
  const cloudflareAiToken = values.get(names.cloudflareAiToken);
  const workloadAuth = values.get(names.workloadAuth);
  if (!cloudflareAiToken || !workloadAuth) throw new ConfigError("required transcription secret is unavailable");
  const deepInfraToken = names.deepInfraToken ? values.get(names.deepInfraToken) : undefined;
  if (names.deepInfraToken && !deepInfraToken) throw new ConfigError("required DeepInfra secret is unavailable");
  return {
    cloudflareAiToken,
    workloadAuth,
    ...(deepInfraToken === undefined ? {} : { deepInfraToken }),
  };
}

function validParameterName(value: string): boolean {
  return value.length <= 2_048 && !value.includes("*") && (value.startsWith("/") || /^arn:aws:ssm:[a-z0-9-]+:\d{12}:parameter\/[A-Za-z0-9_.\-/]+$/.test(value));
}
