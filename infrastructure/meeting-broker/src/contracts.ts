export const brokerPath = "/local-chalk";
export const browserSessionCookie = "__Secure-chalk_session";
export const maximumBodyBytes = 8_192;
export const maximumDisplayNameLength = 80;
export const maximumMeetingParticipants = 32;
export const meetingLifetimeSeconds = 3_600;

export type TraceContext = {
  readonly journeyId: string;
  readonly rootJourneyId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
};

export type BrowserSessionInput = {
  readonly displayName: string;
  readonly inviteToken?: string;
};

export type AccessInput = {
  readonly currentMediaToken?: string;
  readonly replaceMediaConnection: boolean;
};

export type InternalBrowserSessionInput = {
  readonly action: "create" | "join" | "resume";
  readonly browserSessionId: string;
  readonly displayName: string;
  readonly trace: TraceContext;
};

export type InternalSessionInput = {
  readonly browserSessionId: string;
  readonly trace: TraceContext;
};

export type InternalAccessInput = InternalSessionInput & AccessInput;

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
  readonly CHALK_ROOM_ID: string;
  readonly CHALK_SYNC_URL: string;
  readonly CHALK_TENANT_ID: string;
  readonly CHALK_MEETING_LIFETIME_SECONDS?: string;
  readonly CHALK_API_SERVICE?: FetcherLike;
  readonly CREATE_RATE_LIMITER: RateLimitBinding;
  readonly SESSION_RATE_LIMITER: RateLimitBinding;
  readonly MEETING_SESSIONS: DurableObjectNamespaceLike;
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
