import { providerSchemaError } from "./errors.js";

export function nativeDeepInfraBody(body: unknown, maxTextChars: number): unknown {
  if (typeof body !== "object" || body === null || !("words" in body) || body.words == null) return body;
  if (!Array.isArray(body.words)) throw providerSchemaError("DeepInfra words were invalid", "words", "array", body.words);
  const words = body.words.map((item: unknown, index) => {
    if (typeof item !== "object" || item === null) throw providerSchemaError("DeepInfra word was invalid", `words[${index}]`, "object", item);
    if ("word" in item) return item;
    if (!("text" in item)) throw providerSchemaError("DeepInfra word text was missing", `words[${index}].text`, "string", undefined);
    if (typeof item.text !== "string" || item.text.length > maxTextChars) throw providerSchemaError("DeepInfra word text was invalid", `words[${index}].text`, "bounded string", item.text);
    return { ...item, word: item.text };
  });
  return { ...body, words };
}

export function observedDeepInfraIdentity(response: Response, body: unknown): string | undefined {
  const candidates: [string, unknown][] = [
    ["headers.x-deepinfra-execution-identity", response.headers.get("x-deepinfra-execution-identity")],
    ["headers.x-execution-identity", response.headers.get("x-execution-identity")],
  ];
  if (typeof body === "object" && body !== null) {
    if ("execution_identity" in body) candidates.push(["execution_identity", body.execution_identity]);
    if ("executionIdentity" in body) candidates.push(["executionIdentity", body.executionIdentity]);
  }
  return observedText(candidates, "execution identity");
}

export function observedDeepInfraVersion(response: Response, body: unknown): string | undefined {
  const candidates: [string, unknown][] = [["headers.x-deepinfra-model-version", response.headers.get("x-deepinfra-model-version")]];
  if (typeof body === "object" && body !== null) {
    if ("model_version" in body) candidates.push(["model_version", body.model_version]);
    if ("modelVersion" in body) candidates.push(["modelVersion", body.modelVersion]);
  }
  return observedText(candidates, "model version");
}

export function observedDeepInfraCost(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("inference_status" in body) || body.inference_status == null) return undefined;
  const status = body.inference_status;
  if (typeof status !== "object" || !("cost" in status) || status.cost == null) return undefined;
  if (typeof status.cost !== "number" || !Number.isFinite(status.cost) || status.cost < 0 || status.cost > 1_000) throw providerSchemaError("DeepInfra reported cost was invalid", "inference_status.cost", "finite number in [0, 1000]", status.cost);
  // The native inference API reports US cents; transcript metadata stores USD.
  return status.cost / 100;
}

function observedText(candidates: [string, unknown][], label: string): string | undefined {
  let observed: string | undefined;
  for (const [path, value] of candidates) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 256) throw providerSchemaError(`DeepInfra ${label} was invalid`, path, "nonempty string up to 256 characters", value);
    if (observed !== undefined && observed !== value) throw providerSchemaError(`DeepInfra ${label} was inconsistent`, path, "consistent string", value);
    observed = value;
  }
  return observed;
}
