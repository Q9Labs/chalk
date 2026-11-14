import { createHash, createHmac, randomBytes } from "node:crypto";
import type { JourneyContext } from "./types.js";

export interface WorkloadSignerInput {
  method: string;
  path: string;
  body: string;
  context: JourneyContext;
}

/** Signs one control API request; the result holds the headers the API verifies. */
export type WorkloadSigner = (input: WorkloadSignerInput) => Record<string, string>;

interface WorkloadSignerOptions {
  secret: string;
  environment: string;
  releaseId: string;
  audience: string;
  role?: string;
  now?: () => number;
  nonce?: () => string;
}

export function createWorkloadSigner(options: WorkloadSignerOptions): WorkloadSigner {
  const { secret, environment, releaseId, audience, role = "transcription-dispatcher", now = Date.now, nonce: newNonce = () => randomBytes(16).toString("base64url") } = options;

  return (input) => {
    const timestamp = Math.floor(now() / 1_000).toString();
    const nonce = newNonce();
    if (nonce.length < 16 || nonce.length > 128) throw new Error("workload nonce exceeds bound");
    if (input.path.length === 0 || input.path.length > 512) throw new Error("workload path exceeds bound");
    if (input.context.journeyId.length === 0 || input.context.journeyId.length > 128) throw new Error("journey ID exceeds bound");
    const bodySha256 = createHash("sha256").update(input.body).digest("hex");
    const canonical = [input.method.toUpperCase(), input.path, bodySha256, timestamp, nonce, environment, releaseId, role, input.context.journeyId, input.context.traceparent ?? "", input.context.tracestate ?? "", audience].join("\n");
    const signature = createHmac("sha256", secret).update(canonical).digest("base64url");
    return {
      authorization: `Chalk-Workload-HMAC ${signature}`,
      "x-chalk-workload-timestamp": timestamp,
      "x-chalk-workload-nonce": nonce,
      "x-chalk-workload-environment": environment,
      "x-chalk-workload-release": releaseId,
      "x-chalk-workload-role": role,
      "x-chalk-workload-audience": audience,
      "x-chalk-workload-body-sha256": bodySha256,
    };
  };
}
