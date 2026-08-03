import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { ChalkAPIError, createChalkServerClient, type ChalkServerClient, type ParticipantAccess } from "@q9labsai/chalk-client/server";

import { BrokerError, maximumDisplayNameLength, maximumMeetingParticipants, meetingLifetimeSeconds, type InternalAccessInput, type InternalClientSessionInput, type InternalSessionInput, type TraceContext, type WorkerEnv } from "./contracts";
import { empty, json } from "./http";
import { MeetingStore, type ClientRecord, type MeetingRecord } from "./store";

export class MeetingSession extends DurableObject<WorkerEnv> {
  private readonly store: MeetingStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly environment: WorkerEnv,
  ) {
    super(state, environment);
    this.store = new MeetingStore(state.storage.sql);
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
      () => this.expireMeeting(),
      () => this.expireMeeting(),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." }, { allow: "POST" });
    const path = new URL(request.url).pathname;
    try {
      const body = await request.json();
      if (path === "/browser-session" || path === "/client-session") return await this.createClientSession(internalClientSessionInput(body));
      if (path === "/access") return await this.access(internalAccessInput(body));
      if (path === "/cleanup") return await this.cleanup(internalSessionInput(body));
      return json(404, { error: "Not found." });
    } catch (error) {
      const status = error instanceof BrokerError ? error.status : 502;
      const message = error instanceof BrokerError ? error.message : "The meeting broker could not complete the request.";
      this.log("operation_failed", { path, status, upstreamOrigin: configuredOrigin(this.environment.CHALK_API_URL), ...chalkErrorFields(error) });
      return json(status, { error: message });
    }
  }

  private async createClientSession(input: InternalClientSessionInput): Promise<Response> {
    const now = Date.now();
    let meeting = this.store.meeting();
    if (!meeting) {
      if (input.action !== "create") throw new BrokerError(404, "The meeting invite is invalid or expired.");
      meeting = {
        logId: crypto.randomUUID(),
        createdAt: now,
        expiresAt: now + configuredLifetimeSeconds(this.environment) * 1_000,
        hostClientSessionId: input.clientSessionId,
      };
      this.store.createMeeting(meeting);
      await this.state.storage.setAlarm(meeting.expiresAt);
      this.log("meeting_created", { meetingLogId: meeting.logId });
    } else if (input.action === "create") {
      throw new BrokerError(409, "The meeting could not be created.");
    }
    requireActive(meeting, now);
    if (input.action === "resume") {
      const client = requireClient(this.store.client(input.clientSessionId));
      this.store.touchClient(client.clientSessionId, now);
      this.log("client_session_resumed", { meetingLogId: meeting.logId, role: client.isHost ? "host" : "participant" });
      return json(201, { apiBaseURL: this.environment.CHALK_API_URL, syncURL: this.environment.CHALK_SYNC_URL });
    }
    if (this.store.clientCount() >= maximumMeetingParticipants) throw new BrokerError(409, "The meeting is full.");
    this.store.addClient({ clientSessionId: input.clientSessionId, displayName: input.displayName, isHost: meeting.hostClientSessionId === input.clientSessionId }, now);
    this.log("client_session_created", { meetingLogId: meeting.logId, role: meeting.hostClientSessionId === input.clientSessionId ? "host" : "participant" });
    return json(201, { apiBaseURL: this.environment.CHALK_API_URL, syncURL: this.environment.CHALK_SYNC_URL });
  }

  private async access(input: InternalAccessInput): Promise<Response> {
    const now = Date.now();
    let meeting = requireMeeting(this.store.meeting());
    requireActive(meeting, now);
    let client = requireClient(this.store.client(input.clientSessionId));
    this.store.touchClient(client.clientSessionId, now);
    const chalk = this.chalk(input.trace);

    if (!meeting.sessionId) {
      const session = await chalk.sessions.create(
        this.environment.CHALK_ROOM_ID,
        {
          admission_policy: "open",
          host_exit_policy: "continue",
          maximum_duration_seconds: Math.max(1, Math.floor((meeting.expiresAt - now) / 1_000)),
          role_capabilities: {},
        },
        { idempotencyKey: `meeting-session-${meeting.logId}` },
      );
      this.store.setSession(session.id);
      meeting = { ...meeting, sessionId: session.id };
      this.log("session_created", { meetingLogId: meeting.logId });
    }
    const sessionId = meeting.sessionId;
    if (!sessionId) throw new BrokerError(502, "The meeting session is incomplete.");

    if (client.participantGeneration === undefined) {
      const participantSessionId = client.participantSessionId ?? crypto.randomUUID();
      this.store.setParticipant(client.clientSessionId, participantSessionId);
      const admission = await chalk.participants.admit(
        this.environment.CHALK_ROOM_ID,
        sessionId,
        {
          participant_session_id: participantSessionId,
          name: client.displayName,
          initial_role: client.isHost ? "host" : "participant",
          eligible_roles: ["host", "cohost", "participant"],
        },
        { idempotencyKey: `meeting-admit-${participantSessionId}` },
      );
      this.store.setParticipant(client.clientSessionId, participantSessionId, admission.participant.generation);
      client = { ...client, participantSessionId, participantGeneration: admission.participant.generation };
      this.log("participant_admitted", { meetingLogId: meeting.logId, role: client.isHost ? "host" : "participant" });
      if (admission.access) return json(201, admission.access);
    }

    return json(201, await issueAccess(chalk, this.environment.CHALK_ROOM_ID, sessionId, client, input));
  }

  private async cleanup(input: InternalSessionInput): Promise<Response> {
    const meeting = requireMeeting(this.store.meeting());
    const client = requireClient(this.store.client(input.clientSessionId));
    if (!client.isHost) {
      await this.removeGuestParticipant(meeting, client, input.trace);
      this.store.deleteClient(client.clientSessionId);
      this.log("client_session_cleaned", { meetingLogId: meeting.logId });
      return empty(204);
    }
    await this.endMeeting(meeting, input.trace, "host_cleanup");
    return empty(204);
  }

  private async removeGuestParticipant(meeting: MeetingRecord, client: ClientRecord, trace: TraceContext): Promise<void> {
    if (!meeting.sessionId || !client.participantSessionId || client.participantGeneration === undefined) return;
    try {
      await this.chalk(trace).participants.remove(this.environment.CHALK_ROOM_ID, meeting.sessionId, client.participantSessionId, { participantSessionGeneration: client.participantGeneration }, { idempotencyKey: `meeting-remove-${client.participantSessionId}-${client.participantGeneration}` });
    } catch (error) {
      if (error instanceof ChalkAPIError && ["participant_not_active", "participant_not_found", "episode_not_active", "episode_not_found", "session_not_active", "session_not_found"].includes(error.code)) return;
      throw error;
    }
  }

  private async expireMeeting(): Promise<void> {
    const meeting = this.store.meeting();
    if (!meeting) return;
    if (Date.now() < meeting.expiresAt) {
      await this.state.storage.setAlarm(meeting.expiresAt);
      return;
    }
    const trace = generatedTrace();
    try {
      await this.endMeeting(meeting, trace, "lifetime_alarm");
    } catch {
      await this.state.storage.setAlarm(Date.now() + 60_000);
      this.log("meeting_end_retry_scheduled", { meetingLogId: meeting.logId });
      throw new Error("Meeting end retry scheduled");
    }
  }

  private async endMeeting(meeting: MeetingRecord, trace: TraceContext, reason: string): Promise<void> {
    if (meeting.sessionId) {
      try {
        await this.chalk(trace).sessions.end(this.environment.CHALK_ROOM_ID, meeting.sessionId, { idempotencyKey: `meeting-end-${meeting.logId}` });
      } catch (error) {
        if (!(error instanceof ChalkAPIError) || !["episode_not_active", "episode_not_found", "session_not_active", "session_not_found"].includes(error.code)) throw error;
      }
    }
    this.store.clearMeeting();
    await this.state.storage.deleteAlarm();
    this.log("meeting_ended", { meetingLogId: meeting.logId, reason });
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
    console.log(JSON.stringify({ component: "meeting-session", event, ...fields }));
  }
}

async function issueAccess(chalk: ChalkServerClient, roomId: string, sessionId: string, client: ClientRecord, input: InternalAccessInput): Promise<ParticipantAccess> {
  if (!client.participantSessionId || client.participantGeneration === undefined) throw new BrokerError(502, "The participant session is incomplete.");
  if (input.replaceMediaConnection) {
    return chalk.participants.issueAccess(roomId, sessionId, client.participantSessionId, { participantSessionGeneration: client.participantGeneration, replaceMediaConnection: true });
  }
  if (input.currentMediaToken) {
    return chalk.participants.issueAccess(roomId, sessionId, client.participantSessionId, {
      participantSessionGeneration: client.participantGeneration,
      currentMediaToken: input.currentMediaToken,
      replaceMediaConnection: false,
    });
  }
  return chalk.participants.issueAccess(roomId, sessionId, client.participantSessionId, { participantSessionGeneration: client.participantGeneration, replaceMediaConnection: true });
}

function requireMeeting(meeting: MeetingRecord | undefined): MeetingRecord {
  if (!meeting) throw new BrokerError(401, "The client session is missing or expired.");
  return meeting;
}

function requireClient(client: ClientRecord | undefined): ClientRecord {
  if (!client) throw new BrokerError(401, "The client session is missing or expired.");
  return client;
}

function requireActive(meeting: MeetingRecord, now: number): void {
  if (now >= meeting.expiresAt) throw new BrokerError(410, "The meeting has ended.");
}

function internalClientSessionInput(value: unknown): InternalClientSessionInput {
  const input = record(value);
  const action = input.action;
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if ((action !== "create" && action !== "join" && action !== "resume") || !capability(input.clientSessionId) || !displayName || displayName.length > maximumDisplayNameLength) throw new BrokerError(400, "Invalid client session request.");
  return { action, clientSessionId: input.clientSessionId, displayName, trace: trace(input.trace) };
}

function internalAccessInput(value: unknown): InternalAccessInput {
  const input = record(value);
  if (!capability(input.clientSessionId) || typeof input.replaceMediaConnection !== "boolean") throw new BrokerError(400, "Invalid access request.");
  if (input.currentMediaToken !== undefined && typeof input.currentMediaToken !== "string") throw new BrokerError(400, "Invalid access request.");
  return { clientSessionId: input.clientSessionId, replaceMediaConnection: input.replaceMediaConnection, ...(typeof input.currentMediaToken === "string" ? { currentMediaToken: input.currentMediaToken } : {}), trace: trace(input.trace) };
}

function internalSessionInput(value: unknown): InternalSessionInput {
  const input = record(value);
  if (!capability(input.clientSessionId)) throw new BrokerError(400, "Invalid cleanup request.");
  return { clientSessionId: input.clientSessionId, trace: trace(input.trace) };
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

function configuredLifetimeSeconds(environment: WorkerEnv): number {
  const configured = Number(environment.CHALK_MEETING_LIFETIME_SECONDS ?? meetingLifetimeSeconds);
  if (!Number.isSafeInteger(configured) || configured < 1) return meetingLifetimeSeconds;
  return Math.min(configured, meetingLifetimeSeconds);
}
