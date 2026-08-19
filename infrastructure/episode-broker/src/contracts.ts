export const brokerPath = "/local-chalk";
export const browserCredentialCookie = "__Secure-chalk_participant_credential";
export const maximumBodyBytes = 8_192;
export const maximumDisplayNameLength = 80;
export const maximumEpisodeParticipants = 32;
export const episodeDeadlineSeconds = 3_600;

export type TraceContext = {
  readonly journeyId: string;
  readonly rootJourneyId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
};

export type BrowserParticipantCredentialInput = {
  readonly displayName: string;
  readonly spaceInviteToken?: string;
};

export type ParticipantCredentialInput = BrowserParticipantCredentialInput & {
  readonly participantCredentialId?: string;
};

export type AccessInput = {
  readonly currentMediaToken?: string;
  readonly replaceMediaConnection: boolean;
};

export type AccessGrantInput = AccessInput & {
  readonly spaceInviteToken: string;
  readonly participantCredentialId: string;
};

export type InternalParticipantCredentialInput = {
  readonly action: "create" | "join" | "resume";
  readonly participantCredentialId: string;
  readonly displayName: string;
  readonly trace: TraceContext;
};

export type InternalCredentialInput = {
  readonly participantCredentialId: string;
  readonly trace: TraceContext;
};

export type InternalAccessInput = InternalCredentialInput & AccessInput;

export type RateLimitBinding = {
  limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
};

export type DurableObjectStubLike = { fetch(request: Request): Promise<Response> };
export type FetcherLike = { fetch(request: Request): Promise<Response> };
export type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

export type WorkerEnv = {
  readonly CHALK_API_KEY: string;
  readonly CHALK_API_URL: string;
  readonly CHALK_APP_ORIGIN: string;
  readonly CHALK_SPACE_ID: string;
  readonly CHALK_SYNC_URL: string;
  readonly CHALK_TENANT_ID: string;
  readonly CHALK_EPISODE_DEADLINE_SECONDS?: string;
  readonly CHALK_API_SERVICE?: FetcherLike;
  readonly CREATE_RATE_LIMITER: RateLimitBinding;
  readonly EPISODE_RATE_LIMITER: RateLimitBinding;
  readonly EPISODE_LEASES: DurableObjectNamespaceLike;
  readonly SPACE_CREATE_RATE_LIMITER: RateLimitBinding;
};

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
  }
}
