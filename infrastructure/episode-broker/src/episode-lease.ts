import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { ChalkAPIError, createChalkServerClient, type AccessGrant, type ChalkServerClient } from "@q9labsai/chalk-client/server";

import { BrokerError, episodeDeadlineSeconds, maximumDisplayNameLength, maximumEpisodeParticipants, type InternalAccessInput, type InternalCredentialInput, type InternalParticipantCredentialInput, type TraceContext, type WorkerEnv } from "./contracts";
import { empty, json } from "./http";
import { LeaseStore, type LeaseRecord, type ParticipantCredentialRecord } from "./store";

export class EpisodeLease extends DurableObject<WorkerEnv> {
  private readonly store: LeaseStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly environment: WorkerEnv,
  ) {
    super(state, environment);
    this.store = new LeaseStore(state.storage.sql);
  }

  // fallow-ignore-next-line unused-class-member
  fetch(request: Request): Promise<Response> {
    const response = this.queue.then(
      () => this.handle(request),
      () => this.handle(request),
    );
    this.queue = response.catch(() => undefined);
    return response;
  }

  // fallow-ignore-next-line unused-class-member
  alarm(): Promise<void> {
    const operation = this.queue.then(
      () => this.expireLease(),
      () => this.expireLease(),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." }, { allow: "POST" });
    const path = new URL(request.url).pathname;
    try {
      const body = await request.json();
      if (path === "/participant-credentials") return await this.createParticipantCredential(internalParticipantCredentialInput(body));
      if (path === "/access-grants") return await this.accessGrant(internalAccessInput(body));
      if (path === "/participant-credentials/cleanup") return await this.cleanup(internalCredentialInput(body));
      return json(404, { error: "Not found." });
    } catch (error) {
      const status = error instanceof BrokerError ? error.status : 502;
      const message = error instanceof BrokerError ? error.message : "The Episode broker could not complete the request.";
      this.log("operation_failed", { path, status, upstreamOrigin: configuredOrigin(this.environment.CHALK_API_URL), ...chalkErrorFields(error) });
      return json(status, { error: message });
    }
  }

  private async createParticipantCredential(input: InternalParticipantCredentialInput): Promise<Response> {
    const now = Date.now();
    let lease = this.store.lease();
    if (!lease) {
      if (input.action !== "create") throw new BrokerError(404, "The Space invite is invalid or expired.");
      lease = {
        logId: crypto.randomUUID(),
        createdAt: now,
        expiresAt: now + configuredEpisodeDeadlineSeconds(this.environment) * 1_000,
        creatorCredentialId: input.participantCredentialId,
      };
      this.store.createLease(lease);
      await this.state.storage.setAlarm(lease.expiresAt);
      this.log("episode_lease_created", { episodeLeaseLogId: lease.logId });
    } else if (input.action === "create") {
      throw new BrokerError(409, "The Episode lease could not be created.");
    }
    requireActiveLease(lease, now);
    if (input.action === "resume") {
      const credential = requireCredential(this.store.credential(input.participantCredentialId));
      this.store.touchCredential(credential.participantCredentialId, now);
      this.log("participant_credential_resumed", { episodeLeaseLogId: lease.logId, role: credential.isCreator ? "owner" : "collaborator" });
      return json(201, { apiBaseURL: this.environment.CHALK_API_URL, syncURL: this.environment.CHALK_SYNC_URL });
    }
    if (this.store.credentialCount() >= maximumEpisodeParticipants) throw new BrokerError(409, "The Episode is full.");
    const isCreator = lease.creatorCredentialId === input.participantCredentialId;
    this.store.addCredential({ participantCredentialId: input.participantCredentialId, displayName: input.displayName, isCreator }, now);
    this.log("participant_credential_created", { episodeLeaseLogId: lease.logId, role: isCreator ? "owner" : "collaborator" });
    return json(201, { apiBaseURL: this.environment.CHALK_API_URL, syncURL: this.environment.CHALK_SYNC_URL });
  }

  private async accessGrant(input: InternalAccessInput): Promise<Response> {
    const now = Date.now();
    let lease = requireLease(this.store.lease());
    requireActiveLease(lease, now);
    let credential = requireCredential(this.store.credential(input.participantCredentialId));
    this.store.touchCredential(credential.participantCredentialId, now);
    const chalk = this.chalk(input.trace);

    if (!lease.episodeId) {
      const episode = await chalk.episodes.create(this.environment.CHALK_SPACE_ID, {}, { idempotencyKey: `episode-lease-${lease.logId}` });
      this.store.setEpisode(episode.id);
      lease = { ...lease, episodeId: episode.id };
      this.log("episode_created", { episodeLeaseLogId: lease.logId });
    }
    const episodeId = lease.episodeId;
    if (!episodeId) throw new BrokerError(502, "The Episode lease is incomplete.");

    if (credential.participantGeneration === undefined) {
      const participantId = credential.participantId ?? crypto.randomUUID();
      this.store.setParticipant(credential.participantCredentialId, participantId);
      const admission = await chalk.participants.admit(
        this.environment.CHALK_SPACE_ID,
        episodeId,
        {
          name: credential.displayName,
          participantId,
          role: credential.isCreator ? "owner" : "collaborator",
        },
        { idempotencyKey: `episode-admit-${participantId}` },
      );
      this.store.setParticipant(credential.participantCredentialId, participantId, admission.participant.generation);
      credential = { ...credential, participantId, participantGeneration: admission.participant.generation };
      this.log("participant_admitted", { episodeLeaseLogId: lease.logId, role: credential.isCreator ? "owner" : "collaborator" });
      if (admission.access) return json(201, admission.access);
    }

    return json(201, await issueAccessGrant(chalk, this.environment.CHALK_SPACE_ID, episodeId, credential, input));
  }

  private async cleanup(input: InternalCredentialInput): Promise<Response> {
    const lease = requireLease(this.store.lease());
    const credential = requireCredential(this.store.credential(input.participantCredentialId));
    if (!credential.isCreator) {
      await this.removeParticipant(lease, credential, input.trace);
      this.store.deleteCredential(credential.participantCredentialId);
      this.log("participant_credential_cleaned", { episodeLeaseLogId: lease.logId });
      return empty(204);
    }
    await this.endEpisode(lease, input.trace, "creator_cleanup");
    return empty(204);
  }

  private async removeParticipant(lease: LeaseRecord, credential: ParticipantCredentialRecord, trace: TraceContext): Promise<void> {
    if (!lease.episodeId || !credential.participantId || credential.participantGeneration === undefined) return;
    try {
      await this.chalk(trace).participants.remove(this.environment.CHALK_SPACE_ID, lease.episodeId, credential.participantId, { participantGeneration: credential.participantGeneration }, { idempotencyKey: `episode-remove-${credential.participantId}-${credential.participantGeneration}` });
    } catch (error) {
      if (error instanceof ChalkAPIError && ["participant_not_active", "participant_not_found", "episode_not_active", "episode_not_found"].includes(error.code)) return;
      throw error;
    }
  }

  private async expireLease(): Promise<void> {
    const lease = this.store.lease();
    if (!lease) return;
    if (Date.now() < lease.expiresAt) {
      await this.state.storage.setAlarm(lease.expiresAt);
      return;
    }
    const trace = generatedTrace();
    try {
      await this.endEpisode(lease, trace, "deadline_alarm");
    } catch {
      await this.state.storage.setAlarm(Date.now() + 60_000);
      this.log("episode_end_retry_scheduled", { episodeLeaseLogId: lease.logId });
      throw new Error("Episode end retry scheduled");
    }
  }

  private async endEpisode(lease: LeaseRecord, trace: TraceContext, reason: string): Promise<void> {
    if (lease.episodeId) {
      try {
        await this.chalk(trace).episodes.end(this.environment.CHALK_SPACE_ID, lease.episodeId, { idempotencyKey: `episode-end-${lease.logId}` });
      } catch (error) {
        if (!(error instanceof ChalkAPIError) || !["episode_not_active", "episode_not_found"].includes(error.code)) throw error;
      }
    }
    this.store.clearLease();
    await this.state.storage.deleteAlarm();
    this.log("episode_ended", { episodeLeaseLogId: lease.logId, reason });
  }

  private chalk(trace: TraceContext): ChalkServerClient {
    return createChalkServerClient({
      apiKey: this.environment.CHALK_API_KEY,
      tenantId: this.environment.CHALK_TENANT_ID,
      apiBaseURL: this.environment.CHALK_API_URL,
      fetch: this.environment.CHALK_API_SERVICE
        ? (input, init) => this.environment.CHALK_API_SERVICE!.fetch(new Request(input, init))
        : async (input, init) => {
            try {
              return await fetch(input, init);
            } catch (error) {
              this.log("api_fetch_failed", {
                errorName: error instanceof Error ? error.name : "UnknownError",
                errorMessage: error instanceof Error ? error.message.slice(0, 160) : "Unknown fetch failure",
              });
              throw error;
            }
          },
      headers: { "x-chalk-root-journey-id": trace.rootJourneyId },
      telemetry: trace,
    });
  }

  private log(event: string, fields: Readonly<Record<string, boolean | number | string>>): void {
    console.log(JSON.stringify({ component: "episode-lease", event, ...fields }));
  }
}

async function issueAccessGrant(chalk: ChalkServerClient, spaceId: string, episodeId: string, credential: ParticipantCredentialRecord, input: InternalAccessInput): Promise<AccessGrant> {
  if (!credential.participantId || credential.participantGeneration === undefined) throw new BrokerError(502, "The Participant is incomplete.");
  if (input.replaceMediaConnection) {
    return chalk.participants.issueAccess(spaceId, episodeId, credential.participantId, { participantGeneration: credential.participantGeneration, replaceMediaConnection: true });
  }
  if (input.currentMediaToken) {
    return chalk.participants.issueAccess(spaceId, episodeId, credential.participantId, {
      participantGeneration: credential.participantGeneration,
      currentMediaToken: input.currentMediaToken,
      replaceMediaConnection: false,
    });
  }
  return chalk.participants.issueAccess(spaceId, episodeId, credential.participantId, { participantGeneration: credential.participantGeneration, replaceMediaConnection: true });
}

function requireLease(lease: LeaseRecord | undefined): LeaseRecord {
  if (!lease) throw new BrokerError(401, "The Participant credential is missing or expired.");
  return lease;
}

function requireCredential(credential: ParticipantCredentialRecord | undefined): ParticipantCredentialRecord {
  if (!credential) throw new BrokerError(401, "The Participant credential is missing or expired.");
  return credential;
}

function requireActiveLease(lease: LeaseRecord, now: number): void {
  if (now >= lease.expiresAt) throw new BrokerError(410, "The Episode has ended.");
}

function internalParticipantCredentialInput(value: unknown): InternalParticipantCredentialInput {
  const input = record(value);
  const action = input.action;
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if ((action !== "create" && action !== "join" && action !== "resume") || !capability(input.participantCredentialId) || !displayName || displayName.length > maximumDisplayNameLength) throw new BrokerError(400, "Invalid Participant credential request.");
  return { action, participantCredentialId: input.participantCredentialId, displayName, trace: trace(input.trace) };
}

function internalAccessInput(value: unknown): InternalAccessInput {
  const input = record(value);
  if (!capability(input.participantCredentialId) || typeof input.replaceMediaConnection !== "boolean") throw new BrokerError(400, "Invalid access grant request.");
  if (input.currentMediaToken !== undefined && typeof input.currentMediaToken !== "string") throw new BrokerError(400, "Invalid access grant request.");
  return { participantCredentialId: input.participantCredentialId, replaceMediaConnection: input.replaceMediaConnection, ...(typeof input.currentMediaToken === "string" ? { currentMediaToken: input.currentMediaToken } : {}), trace: trace(input.trace) };
}

function internalCredentialInput(value: unknown): InternalCredentialInput {
  const input = record(value);
  if (!capability(input.participantCredentialId)) throw new BrokerError(400, "Invalid cleanup request.");
  return { participantCredentialId: input.participantCredentialId, trace: trace(input.trace) };
}

function trace(value: unknown): TraceContext {
  const input = record(value);
  if (typeof input.journeyId !== "string" || typeof input.rootJourneyId !== "string" || typeof input.traceparent !== "string") throw new BrokerError(400, "Invalid trace context.");
  return { journeyId: input.journeyId, rootJourneyId: input.rootJourneyId, traceparent: input.traceparent, ...(typeof input.tracestate === "string" ? { tracestate: input.tracestate } : {}) };
}

function capability(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BrokerError(400, "Invalid broker request.");
  return value as Record<string, unknown>;
}

function generatedTrace(): TraceContext {
  const journeyId = crypto.randomUUID();
  const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
  return { journeyId, rootJourneyId: journeyId, traceparent: `00-${hex(16)}-${hex(8)}-01` };
}

function chalkErrorFields(error: unknown): Readonly<Record<string, boolean | number | string>> {
  if (!(error instanceof ChalkAPIError)) return {};
  return { upstreamCode: error.code, upstreamRetryable: error.retryable, upstreamStatus: error.status };
}

function configuredOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

function configuredEpisodeDeadlineSeconds(environment: WorkerEnv): number {
  const configured = Number(environment.CHALK_EPISODE_DEADLINE_SECONDS ?? episodeDeadlineSeconds);
  if (!Number.isSafeInteger(configured) || configured < 1) return episodeDeadlineSeconds;
  return Math.min(configured, episodeDeadlineSeconds);
}
