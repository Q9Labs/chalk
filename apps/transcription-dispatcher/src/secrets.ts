import { ConfigError } from "./errors.js";

export interface SsmParameterClient {
  send(command: {
    input: {
      Names: string[];
      WithDecryption: true;
    };
  }): Promise<{
    Parameters?: Array<{ ARN?: string; Name?: string; Value?: string }>;
    InvalidParameters?: string[];
  }>;
}

export interface DispatcherSecrets {
  deepInfraToken?: string;
  cloudflareAiToken?: string;
  workloadAuth: string;
}

export interface SecretParameterNames {
  deepInfraToken?: string;
  cloudflareAiToken?: string;
  workloadAuth: string;
}

/**
 * Reads only the enabled providers' environment-scoped SSM parameters and the workload key.
 * Values are returned to the caller for process-memory use and are never logged,
 * serialized, or retained by this loader.
 */
export async function loadDispatcherSecrets(client: SsmParameterClient, names: SecretParameterNames): Promise<DispatcherSecrets> {
  const requested = [names.workloadAuth, ...(names.cloudflareAiToken ? [names.cloudflareAiToken] : []), ...(names.deepInfraToken ? [names.deepInfraToken] : [])];
  if (requested.some((name) => !validParameterName(name))) throw new ConfigError("invalid SSM parameter ARN/name");
  if (new Set(requested).size !== requested.length) throw new ConfigError("SSM parameter names must be distinct");
  const response = await client.send({ input: { Names: requested, WithDecryption: true } });
  if (response.InvalidParameters?.length) throw new ConfigError("required transcription SSM parameter is unavailable");
  const values = new Map<string, string>();
  for (const parameter of response.Parameters ?? []) {
    if (!parameter.Value || (!parameter.Name && !parameter.ARN)) throw new ConfigError("SSM returned an invalid parameter");
    const requestedName = [parameter.ARN, parameter.Name].find((identity) => identity !== undefined && requested.includes(identity));
    if (!requestedName) throw new ConfigError("SSM returned an unexpected parameter");
    if (values.has(requestedName)) throw new ConfigError("SSM returned a duplicate parameter");
    values.set(requestedName, parameter.Value);
  }
  const cloudflareAiToken = names.cloudflareAiToken ? values.get(names.cloudflareAiToken) : undefined;
  const workloadAuth = values.get(names.workloadAuth);
  if (!workloadAuth || (names.cloudflareAiToken && !cloudflareAiToken)) throw new ConfigError("required transcription secret is unavailable");
  const deepInfraToken = names.deepInfraToken ? values.get(names.deepInfraToken) : undefined;
  if (names.deepInfraToken && !deepInfraToken) throw new ConfigError("required DeepInfra secret is unavailable");
  return {
    ...(cloudflareAiToken === undefined ? {} : { cloudflareAiToken }),
    workloadAuth,
    ...(deepInfraToken === undefined ? {} : { deepInfraToken }),
  };
}

function validParameterName(value: string): boolean {
  return value.length <= 2_048 && !value.includes("*") && (value.startsWith("/") || /^arn:aws:ssm:[a-z0-9-]+:\d{12}:parameter\/[A-Za-z0-9_.\-/]+$/.test(value));
}
