import { ProviderError } from "./errors.js";

export function nativeDeepInfraBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("words" in body) || body.words == null) return body;
  if (!Array.isArray(body.words)) throw new ProviderError("DeepInfra words were invalid", "schema");
  const words = body.words.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new ProviderError("DeepInfra word was invalid", "schema");
    if ("word" in item) return item;
    if (!("text" in item)) throw new ProviderError("DeepInfra word text was missing", "schema");
    return { ...item, word: item.text };
  });
  return { ...body, words };
}

export function observedDeepInfraIdentity(response: Response, body: unknown): string | undefined {
  const candidates: unknown[] = [response.headers.get("x-deepinfra-execution-identity"), response.headers.get("x-execution-identity")];
  if (typeof body === "object" && body !== null) {
    if ("execution_identity" in body) candidates.push(body.execution_identity);
    if ("executionIdentity" in body) candidates.push(body.executionIdentity);
  }
  return observedText(candidates, "execution identity");
}

export function observedDeepInfraVersion(response: Response, body: unknown): string | undefined {
  const candidates: unknown[] = [response.headers.get("x-deepinfra-model-version")];
  if (typeof body === "object" && body !== null) {
    if ("model_version" in body) candidates.push(body.model_version);
    if ("modelVersion" in body) candidates.push(body.modelVersion);
  }
  return observedText(candidates, "model version");
}

export function observedDeepInfraCost(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("inference_status" in body) || body.inference_status == null) return undefined;
  const status = body.inference_status;
  if (typeof status !== "object" || !("cost" in status) || status.cost == null) return undefined;
  if (typeof status.cost !== "number" || !Number.isFinite(status.cost) || status.cost < 0 || status.cost > 1_000) throw new ProviderError("DeepInfra reported cost was invalid", "schema");
  // The native inference API reports US cents; transcript metadata stores USD.
  return status.cost / 100;
}

function observedText(candidates: unknown[], label: string): string | undefined {
  let observed: string | undefined;
  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new ProviderError(`DeepInfra ${label} was invalid`, "schema");
    if (observed !== undefined && observed !== value) throw new ProviderError(`DeepInfra ${label} was inconsistent`, "schema");
    observed = value;
  }
  return observed;
}
