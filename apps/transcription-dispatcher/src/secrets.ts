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

/** One string per secret: SSM parameter names on the way in, their values on the way out. */
export interface SecretSlots {
  openRouterToken: string;
  workloadAuth: string;
}

export type SecretParameterNames = SecretSlots;
export type DispatcherSecrets = SecretSlots;

/**
 * Reads the environment-scoped OpenRouter and workload keys.
 * Values are returned to the caller for process-memory use and are never logged,
 * serialized, or retained by this loader.
 */
export async function loadDispatcherSecrets(client: SsmParameterClient, names: SecretParameterNames): Promise<DispatcherSecrets> {
  const requested = [names.openRouterToken, names.workloadAuth];
  if (requested.some((name) => !validParameterName(name))) throw new ConfigError("invalid SSM parameter ARN/name");
  if (new Set(requested).size !== requested.length) throw new ConfigError("SSM parameter names must be distinct");
  const values = await fetchParameterValues(client, requested);
  const workloadAuth = values.get(names.workloadAuth);
  if (!workloadAuth) throw new ConfigError("required transcription secret is unavailable");
  const openRouterToken = values.get(names.openRouterToken);
  if (!openRouterToken) throw new ConfigError("required OpenRouter secret is unavailable");
  return { openRouterToken, workloadAuth };
}

/** SSM may answer with a name or an ARN; each value is keyed by whichever the caller asked for. */
async function fetchParameterValues(client: SsmParameterClient, requested: readonly string[]): Promise<Map<string, string>> {
  const response = await client.send({ input: { Names: [...requested], WithDecryption: true } });
  if (response.InvalidParameters?.length) throw new ConfigError("required transcription SSM parameter is unavailable");
  const values = new Map<string, string>();
  for (const parameter of response.Parameters ?? []) {
    if (!parameter.Value || (!parameter.Name && !parameter.ARN)) throw new ConfigError("SSM returned an invalid parameter");
    const requestedName = [parameter.ARN, parameter.Name].find((identity) => identity !== undefined && requested.includes(identity));
    if (!requestedName) throw new ConfigError("SSM returned an unexpected parameter");
    if (values.has(requestedName)) throw new ConfigError("SSM returned a duplicate parameter");
    values.set(requestedName, parameter.Value);
  }
  return values;
}

function validParameterName(value: string): boolean {
  return value.length <= 2_048 && !value.includes("*") && (value.startsWith("/") || /^arn:aws:ssm:[a-z0-9-]+:\d{12}:parameter\/[A-Za-z0-9_.\-/]+$/.test(value));
}
