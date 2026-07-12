import { createHash, createHmac, randomBytes } from "node:crypto";
import type { JourneyContext } from "./types.js";

export interface WorkloadSignerInput {
  method: string;
  path: string;
  body: string;
  context: JourneyContext;
}

export interface WorkloadSigner {
  sign(input: WorkloadSignerInput): Record<string, string>;
}

export class HmacWorkloadSigner implements WorkloadSigner {
  private readonly secret: string;
  private readonly environment: string;
  private readonly releaseId: string;
  private readonly audience: string;
  private readonly role: string;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(options: { secret: string; environment: string; releaseId: string; audience: string; role?: string; now?: () => number; nonce?: () => string }) {
    this.secret = options.secret;
    this.environment = options.environment;
    this.releaseId = options.releaseId;
    this.audience = options.audience;
    this.role = options.role ?? "transcription-dispatcher";
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(16).toString("base64url"));
  }

  // fallow-ignore-next-line unused-class-member
  sign(input: WorkloadSignerInput): Record<string, string> {
    const timestamp = Math.floor(this.now() / 1_000).toString();
    const nonce = this.nonce();
    if (nonce.length < 16 || nonce.length > 128) throw new Error("workload nonce exceeds bound");
    if (input.path.length === 0 || input.path.length > 512) throw new Error("workload path exceeds bound");
    if (input.context.journeyId.length === 0 || input.context.journeyId.length > 128) throw new Error("journey ID exceeds bound");
    const bodySha256 = createHash("sha256").update(input.body).digest("hex");
    const canonical = [input.method.toUpperCase(), input.path, bodySha256, timestamp, nonce, this.environment, this.releaseId, this.role, input.context.journeyId, input.context.traceparent ?? "", input.context.tracestate ?? "", this.audience].join("\n");
    const signature = createHmac("sha256", this.secret).update(canonical).digest("base64url");
    return {
      authorization: `Chalk-Workload-HMAC ${signature}`,
      "x-chalk-workload-timestamp": timestamp,
      "x-chalk-workload-nonce": nonce,
      "x-chalk-workload-environment": this.environment,
      "x-chalk-workload-release": this.releaseId,
      "x-chalk-workload-role": this.role,
      "x-chalk-workload-audience": this.audience,
      "x-chalk-workload-body-sha256": bodySha256,
    };
  }
}
