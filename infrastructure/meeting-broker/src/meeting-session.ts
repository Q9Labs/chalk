import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { ChalkAPIError, createChalkServerClient, type ChalkServerClient, type ParticipantAccess } from "@q9labsai/chalk-client/server";

import { BrokerError, maximumDisplayNameLength, maximumMeetingParticipants, meetingLifetimeSeconds, type InternalAccessInput, type InternalBrowserSessionInput, type InternalSessionInput, type TraceContext, type WorkerEnv } from "./contracts";
import { empty, json } from "./http";
import { MeetingStore, type BrowserRecord, type MeetingRecord } from "./store";

const participantCapabilities = ["publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand", "renameSelf"];
const hostCapabilities = [...participantCapabilities, "manageAdmission", "promoteDemote", "transferHost", "muteOthers", "stopVideoOthers", "stopScreenOthers", "requestMediaOthers", "removeParticipant", "endMeeting"];

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
      if (path === "/browser-session") return await this.createBrowserSession(internalBrowserSessionInput(body));
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

  private async createBrowserSession(input: InternalBrowserSessionInput): Promise<Response> {
    const now = Date.now();
    let meeting = this.store.meeting();
    if (!meeting) {
      if (input.action !== "create") throw new BrokerError(404, "The meeting invite is invalid or expired.");
      meeting = {
        logId: crypto.randomUUID(),
        createdAt: now,
        expiresAt: now + configuredLifetimeSeconds(this.environment) * 1_000,
        hostBrowserSessionId: input.browserSessionId,
      };
      this.store.createMeeting(meeting);
      await this.state.storage.setAlarm(meeting.expiresAt);
      this.log("meeting_created", { meetingId: meeting.logId });
    } else if (input.action === "create") {
      throw new BrokerError(409, "The meeting could not be created.");
    }
    requireActive(meeting, now);
    if (input.action === "resume") {
      const browser = requireBrowser(this.store.browser(input.browserSessionId));
      this.store.touchBrowser(browser.browserSessionId, now);
      this.log("browser_session_resumed", { meetingId: meeting.logId, role: browser.isHost ? "host" : "participant" });
      return json(201, { apiBaseURL: this.environment.CHALK_API_URL, syncURL: this.environment.CHALK_SYNC_URL });
    }
    if (this.store.browserCount() >= maximumMeetingParticipants) throw new BrokerError(409, "The meeting is full.");
    this.store.addBrowser({ browserSessionId: input.browserSessionId, displayName: input.displayName, isHost: meeting.hostBrowserSessionId === input.browserSessionId }, now);
    this.log("browser_session_created", { meetingId: meeting.logId, role: meeting.hostBrowserSessionId === input.browserSessionId ? "host" : "participant" });
    return json(201, { apiBaseURL: this.environment.CHALK_API_URL, syncURL: this.environment.CHALK_SYNC_URL });
  }

  private async access(input: InternalAccessInput): Promise<Response> {
    const now = Date.now();
    let meeting = requireMeeting(this.store.meeting());
    requireActive(meeting, now);
    let browser = requireBrowser(this.store.browser(input.browserSessionId));
    this.store.touchBrowser(browser.browserSessionId, now);
    const chalk = this.chalk(input.trace);

    if (!meeting.sessionId) {
      const session = await chalk.sessions.create(
        this.environment.CHALK_ROOM_ID,
        {
          admission_policy: "open",
          host_exit_policy: "require_transfer",
          maximum_duration_seconds: Math.max(1, Math.floor((meeting.expiresAt - now) / 1_000)),
          role_capabilities: { host: hostCapabilities, cohost: participantCapabilities, participant: participantCapabilities },
        },
        { idempotencyKey: `web-meeting-session-${meeting.logId}` },
      );
      this.store.setSession(session.id);
      meeting = { ...meeting, sessionId: session.id };
      this.log("session_created", { meetingId: meeting.logId });
    }
    const sessionId = meeting.sessionId;
    if (!sessionId) throw new BrokerError(502, "The meeting session is incomplete.");

    if (browser.participantGeneration === undefined) {
      const participantSessionId = browser.participantSessionId ?? crypto.randomUUID();
      this.store.setParticipant(browser.browserSessionId, participantSessionId);
      const admission = await chalk.participants.admit(
        this.environment.CHALK_ROOM_ID,
        sessionId,
        {
          participant_session_id: participantSessionId,
          name: browser.displayName,
          initial_role: browser.isHost ? "host" : "participant",
          eligible_roles: browser.isHost ? ["host", "cohost", "participant"] : ["host", "cohost", "participant"],
        },
        { idempotencyKey: `web-meeting-admit-${participantSessionId}` },
      );
      this.store.setParticipant(browser.browserSessionId, participantSessionId, admission.participant.generation);
      browser = { ...browser, participantSessionId, participantGeneration: admission.participant.generation };
      this.log("participant_admitted", { meetingId: meeting.logId, role: browser.isHost ? "host" : "participant" });
      if (admission.access) return json(201, admission.access);
    }

    return json(201, await issueAccess(chalk, this.environment.CHALK_ROOM_ID, sessionId, browser, input));
  }

  private async cleanup(input: InternalSessionInput): Promise<Response> {
    const meeting = requireMeeting(this.store.meeting());
    const browser = requireBrowser(this.store.browser(input.browserSessionId));
    if (!browser.isHost) {
      await this.removeGuestParticipant(meeting, browser, input.trace);
      this.store.deleteBrowser(browser.browserSessionId);
      this.log("guest_cleaned", { meetingId: meeting.logId });
      return empty(204);
    }
    await this.endMeeting(meeting, input.trace, "host_cleanup");
    return empty(204);
  }

  private async removeGuestParticipant(meeting: MeetingRecord, browser: BrowserRecord, trace: TraceContext): Promise<void> {
    if (!meeting.sessionId || !browser.participantSessionId || browser.participantGeneration === undefined) return;
    try {
      await this.chalk(trace).participants.remove(
        this.environment.CHALK_ROOM_ID,
        meeting.sessionId,
        browser.participantSessionId,
        { participantSessionGeneration: browser.participantGeneration },
        { idempotencyKey: `web-meeting-remove-${browser.participantSessionId}-${browser.participantGeneration}` },
      );
    } catch (error) {
      if (error instanceof ChalkAPIError && ["participant_not_active", "participant_not_found", "session_not_active", "session_not_found"].includes(error.code)) return;
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
      this.log("meeting_end_retry_scheduled", { meetingId: meeting.logId });
      throw new Error("Meeting end retry scheduled");
    }
  }

  private async endMeeting(meeting: MeetingRecord, trace: TraceContext, reason: string): Promise<void> {
    if (meeting.sessionId) {
      try {
        await this.chalk(trace).sessions.end(this.environment.CHALK_ROOM_ID, meeting.sessionId, { idempotencyKey: `web-meeting-end-${meeting.logId}` });
      } catch (error) {
        if (!(error instanceof ChalkAPIError) || !["session_not_active", "session_not_found"].includes(error.code)) throw error;
      }
    }
    this.store.clearMeeting();
    await this.state.storage.deleteAlarm();
    this.log("meeting_ended", { meetingId: meeting.logId, reason });
  }

  private chalk(trace: TraceContext): ChalkServerClient {
    return createChalkServerClient({
      apiKey: this.environment.CHALK_API_KEY,
      tenantId: this.environment.CHALK_TENANT_ID,
      apiBaseURL: this.environment.CHALK_API_URL,
      ...(this.environment.CHALK_API_SERVICE ? { fetch: (input, init) => this.environment.CHALK_API_SERVICE!.fetch(new Request(input, init)) } : {}),
      headers: { "x-chalk-root-journey-id": trace.rootJourneyId },
      telemetry: trace,
    });
  }

  private log(event: string, fields: Readonly<Record<string, boolean | number | string>>): void {
    console.log(JSON.stringify({ component: "meeting-session", event, ...fields }));
  }
}

async function issueAccess(chalk: ChalkServerClient, roomId: string, sessionId: string, browser: BrowserRecord, input: InternalAccessInput): Promise<ParticipantAccess> {
  if (!browser.participantSessionId || browser.participantGeneration === undefined) throw new BrokerError(502, "The participant session is incomplete.");
  if (input.replaceMediaConnection) {
    return chalk.participants.issueAccess(roomId, sessionId, browser.participantSessionId, { participantSessionGeneration: browser.participantGeneration, replaceMediaConnection: true });
  }
  if (input.currentMediaToken) {
    return chalk.participants.issueAccess(roomId, sessionId, browser.participantSessionId, {
      participantSessionGeneration: browser.participantGeneration,
      currentMediaToken: input.currentMediaToken,
      replaceMediaConnection: false,
    });
  }
  return chalk.participants.issueAccess(roomId, sessionId, browser.participantSessionId, { participantSessionGeneration: browser.participantGeneration, replaceMediaConnection: true });
}

function requireMeeting(meeting: MeetingRecord | undefined): MeetingRecord {
  if (!meeting) throw new BrokerError(401, "The browser session is missing or expired.");
  return meeting;
}

function requireBrowser(browser: BrowserRecord | undefined): BrowserRecord {
  if (!browser) throw new BrokerError(401, "The browser session is missing or expired.");
  return browser;
}

function requireActive(meeting: MeetingRecord, now: number): void {
  if (now >= meeting.expiresAt) throw new BrokerError(410, "The meeting has ended.");
}

function internalBrowserSessionInput(value: unknown): InternalBrowserSessionInput {
  const input = record(value);
  const action = input.action;
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if ((action !== "create" && action !== "join" && action !== "resume") || !capability(input.browserSessionId) || !displayName || displayName.length > maximumDisplayNameLength) throw new BrokerError(400, "Invalid browser session request.");
  return { action, browserSessionId: input.browserSessionId, displayName, trace: trace(input.trace) };
}

function internalAccessInput(value: unknown): InternalAccessInput {
  const input = record(value);
  if (!capability(input.browserSessionId) || typeof input.replaceMediaConnection !== "boolean") throw new BrokerError(400, "Invalid access request.");
  if (input.currentMediaToken !== undefined && typeof input.currentMediaToken !== "string") throw new BrokerError(400, "Invalid access request.");
  return { browserSessionId: input.browserSessionId, replaceMediaConnection: input.replaceMediaConnection, ...(typeof input.currentMediaToken === "string" ? { currentMediaToken: input.currentMediaToken } : {}), trace: trace(input.trace) };
}

function internalSessionInput(value: unknown): InternalSessionInput {
  const input = record(value);
  if (!capability(input.browserSessionId)) throw new BrokerError(400, "Invalid cleanup request.");
  return { browserSessionId: input.browserSessionId, trace: trace(input.trace) };
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
