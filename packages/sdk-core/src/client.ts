/**
 * ConferenceClient - Main entry point for the Chalk SDK
 * Composed from focused modules for config and join orchestration.
 */

import { Effect } from "effect";
import { APIClient } from "./api-client.ts";
import {
  configureConferenceWideEvents,
  DEFAULT_API_URL,
  deriveWsUrl,
  isTokenExpired as parseTokenExpiry,
} from "./conference-client/config.ts";
import { joinConferenceSession } from "./conference-client/join-session.ts";
import {
  createJoinLock,
  isJoinTimeoutError,
  waitForJoinWithTimeout,
} from "./conference-client/rtk-runtime.ts";
import { ConnectionError, TimeoutError } from "./effect/errors.ts";
import { EventEmitter } from "./events.ts";
import {
  ChalkPostHogSessionReplay,
  type ChalkPostHogConfig,
} from "./posthog.ts";
import { getRtkJoinPolicyForCurrentCohort } from "./rtk-join-policy.ts";
import { ConferenceSession } from "./room.ts";
import type {
  ChalkError,
  ConferenceClientConfig,
  JoinSessionConfig,
  SessionConnectionState,
} from "./types.ts";
import { wideEvents } from "./wide-events/index.ts";
import { WideEventContext } from "./wide-events/context.ts";
import { WSClient } from "./ws-client.ts";

interface ConferenceClientEvents {
  "token.expired": ChalkError;
}

type JoinLock = ReturnType<typeof createJoinLock>;

export class ConferenceClient extends EventEmitter<ConferenceClientEvents> {
  private readonly apiClient: APIClient;
  private readonly wsUrl: string;
  private readonly tokenProvider?: ConferenceClientConfig["tokenProvider"];
  private readonly debug: boolean;
  private readonly demoMode: boolean;
  private currentSession: ConferenceSession | null = null;
  private currentWsClient: WSClient | null = null;
  private readonly postHogSessionReplay = new ChalkPostHogSessionReplay();
  private readonly joinLock: JoinLock = createJoinLock();
  private realtimeKitClientPromise: Promise<
    typeof import("@cloudflare/realtimekit")["default"]
  > | null = null;

  constructor(config: ConferenceClientConfig) {
    super();

    const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
    this.debug = config.debug ?? false;
    this.demoMode = config.demoMode ?? false;
    this.wsUrl = config.wsUrl ?? deriveWsUrl(apiUrl);
    this.tokenProvider = config.tokenProvider;
    this.postHogSessionReplay.configure(config.posthog);

    const hasAuth =
      config.token || config.tokenProvider || config.apiKey || this.debug;
    if (!hasAuth) {
      throw new Error(
        "ConferenceClient requires authentication: provide token, tokenProvider, or apiKey",
      );
    }

    if (config.apiKey) {
      console.warn(
        "[Chalk] DEPRECATION: `apiKey` is deprecated. Use `token` or `tokenProvider` instead. This option will be removed in v2.0.",
      );
    }

    this.apiClient = new APIClient({ ...config, apiUrl });
    this.apiClient.on("token.expired", (error) => {
      this.emit("token.expired", error);
    });

    configureConferenceWideEvents(config);
  }

  configurePostHog(config?: ChalkPostHogConfig): void {
    this.postHogSessionReplay.configure(config);
  }

  async preloadRealtimeKit(): Promise<boolean> {
    const ctx = wideEvents.start("room.join.rtk.preload");

    try {
      await this._getRealtimeKitClient();
      ctx.complete("success");
      return true;
    } catch (error) {
      ctx.complete("error", error);
      return false;
    }
  }

  private trackPostHogLeave(reason: "disconnect" | "switch_room"): void {
    this.postHogSessionReplay.trackLeave({
      reason,
      roomId: this.currentSession?.id,
      participantId: this.currentSession?.localParticipant?.id,
      demoMode: this.demoMode,
    });
  }

  private _importRealtimeKitClient() {
    return import("@cloudflare/realtimekit").then((module) => module.default);
  }

  private _getRealtimeKitClient() {
    if (this.realtimeKitClientPromise === null) {
      this.realtimeKitClientPromise = this._importRealtimeKitClient().catch(
        (error) => {
          this.realtimeKitClientPromise = null;
          throw error;
        },
      );
    }

    return this.realtimeKitClientPromise;
  }

  // Kept as a private instance method for test seam compatibility.
  private isTokenExpired(token: string): boolean {
    return parseTokenExpiry(token);
  }

  private _initRealtimeKitEffect(
    authToken: string,
    audio: boolean,
    video: boolean,
  ) {
    return Effect.tryPromise({
      try: async () => {
        const realtimeKitClient = await this._getRealtimeKitClient();
        return realtimeKitClient.init({
          authToken,
          defaults: { audio, video },
        });
      },
      catch: (error) =>
        new ConnectionError({
          code: "CONNECTION_FAILED",
          message:
            error instanceof Error ? error.message : "RealtimeKit init failed",
          recoverable: true,
          cause: error,
        }),
    });
  }

  private _joinRealtimeKitEffect(
    joinPromise: Promise<void>,
    timeoutMs: number,
  ) {
    return waitForJoinWithTimeout(joinPromise, timeoutMs);
  }

  private _isJoinTimeoutError(error: Error): boolean {
    return isJoinTimeoutError(error);
  }

  private _emitRtkJoinAttemptTelemetry({
    attempt,
    totalAttempts,
    timeoutMs,
    delayMs,
    attemptDurationMs,
    timeoutVsError,
    outcome,
    errorMessage,
    joinPolicySelection,
  }: {
    attempt: number;
    totalAttempts: number;
    timeoutMs: number;
    delayMs: number;
    attemptDurationMs: number;
    timeoutVsError: "timeout" | "error" | "none";
    outcome: "success" | "timeout" | "error";
    errorMessage?: string;
    joinPolicySelection: ReturnType<typeof getRtkJoinPolicyForCurrentCohort>;
  }): void {
    const attemptCtx = new WideEventContext(
      "room.join.rtk.attempt",
      wideEvents.collector,
    );
    attemptCtx.merge({
      attempt,
      totalAttempts,
      timeoutMs,
      delayMs,
      attemptDurationMs,
      timeoutVsError,
      outcome,
      rtkJoinPolicy: joinPolicySelection,
    });

    if (outcome === "success") {
      attemptCtx.complete("success");
      return;
    }

    attemptCtx.complete(outcome, {
      code:
        timeoutVsError === "timeout" ? "RTK_JOIN_TIMEOUT" : "RTK_JOIN_ERROR",
      message: errorMessage ?? "RTK join attempt failed",
    });
  }

  private async _joinRealtimeKitWithRetry(
    rtkClient: { join: () => Promise<void> },
    joinPolicySelection = getRtkJoinPolicyForCurrentCohort(),
  ): Promise<void> {
    let lastError: Error | null = null;
    let joinPromise: Promise<void> | null = null;
    const retryDelays = joinPolicySelection.policy.retryDelaysMs;
    const timeoutMs = joinPolicySelection.policy.timeoutMs;
    const totalAttempts = 1 + retryDelays.length;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const attemptNumber = attempt + 1;
      const attemptStart = performance.now();

      if (!joinPromise) {
        joinPromise = rtkClient.join();
      }

      try {
        await Effect.runPromise(
          this._joinRealtimeKitEffect(joinPromise, timeoutMs),
        );
        this._emitRtkJoinAttemptTelemetry({
          attempt: attemptNumber,
          totalAttempts,
          timeoutMs,
          delayMs: 0,
          attemptDurationMs: Math.round(performance.now() - attemptStart),
          timeoutVsError: "none",
          outcome: "success",
          joinPolicySelection,
        });
        return;
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        lastError = normalized;
        const timeout =
          normalized instanceof TimeoutError ||
          this._isJoinTimeoutError(normalized);
        const delayMs =
          attempt < retryDelays.length ? retryDelays[attempt]! : 0;

        this._emitRtkJoinAttemptTelemetry({
          attempt: attemptNumber,
          totalAttempts,
          timeoutMs,
          delayMs,
          attemptDurationMs: Math.round(performance.now() - attemptStart),
          timeoutVsError: timeout ? "timeout" : "error",
          outcome: timeout ? "timeout" : "error",
          errorMessage: normalized.message,
          joinPolicySelection,
        });

        if (!timeout) {
          joinPromise = null;
        }

        if (attempt < retryDelays.length) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw new Error(
      `Failed to join room after ${totalAttempts} attempts: ${lastError?.message}`,
    );
  }

  private async initRealtimeKitClient(
    authToken: string,
    audio: boolean,
    video: boolean,
  ) {
    return Effect.runPromise(
      this._initRealtimeKitEffect(authToken, audio, video),
    ).catch((error) => {
      if (error instanceof ConnectionError) {
        throw new Error(`RealtimeKit initialization failed: ${error.message}`);
      }
      throw error;
    });
  }

  async joinSession(
    sessionId: string,
    config: JoinSessionConfig,
  ): Promise<ConferenceSession> {
    return this.joinLock.withLock(async () => {
      if (this.currentSession) {
        this.trackPostHogLeave("switch_room");
        await this.currentSession.leave();
        this.currentSession = null;
      }

      try {
        const joined = await joinConferenceSession(sessionId, config, {
          apiClient: this.apiClient,
          demoMode: this.demoMode,
          wsUrl: this.wsUrl,
          debug: this.debug,
          tokenProvider: this.tokenProvider,
          isTokenExpired: (token) => this.isTokenExpired(token),
          emitTokenExpired: (error) => this.emit("token.expired", error),
          initRealtimeKitClient: (authToken, audio, video) =>
            this.initRealtimeKitClient(authToken, audio, video),
          joinRealtimeKitWithRetry: (rtkClient, policySelection) =>
            this._joinRealtimeKitWithRetry(rtkClient, policySelection),
        });

        this.currentSession = joined.session;
        this.currentWsClient = joined.wsClient;

        this.postHogSessionReplay.trackJoinSucceeded({
          roomId: joined.roomId,
          participantId: joined.participantId,
          role: joined.role,
          displayName: config.displayName,
          demoMode: this.demoMode,
        });

        if (joined.shouldStartRecording) {
          this.startRecording().catch(() => {
            // non-blocking
          });
        }

        return joined.session;
      } catch (error) {
        this.postHogSessionReplay.trackJoinFailed({
          roomId: sessionId,
          displayName: config.displayName,
          error: error instanceof Error ? error.message : String(error),
          demoMode: this.demoMode,
        });
        throw error;
      }
    });
  }

  async createSession(
    name?: string,
    config?: Record<string, unknown>,
  ): Promise<string> {
    const ctx = wideEvents.start("room.create");
    ctx.set("input", { name, config });

    try {
      const response = await this.apiClient.createSession(name, config);
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? "Failed to create room");
      }

      ctx.complete("success", { roomId: response.data.roomId });
      return response.data.roomId;
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const ctx = wideEvents.start("room.end");
    ctx.set("input", { roomId: sessionId });

    try {
      const response = await this.apiClient.endSession(sessionId);
      if (!response.success) {
        throw new Error(response.error?.message ?? "Failed to end room");
      }
      ctx.complete("success");
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  async startRecording(): Promise<string> {
    const ctx = wideEvents.start("recording.start");

    try {
      if (!this.currentSession) {
        throw new Error("Not connected to a room");
      }

      ctx.set("input", { roomId: this.currentSession.id });
      const response = await this.apiClient.startRecording(
        this.currentSession.id,
      );
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? "Failed to start recording");
      }

      ctx.complete("success", { recordingId: response.data.recordingId });
      return response.data.recordingId;
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  async stopRecording(): Promise<void> {
    const ctx = wideEvents.start("recording.stop");

    try {
      if (!this.currentSession) {
        throw new Error("Not connected to a room");
      }

      ctx.set("input", { roomId: this.currentSession.id });
      const response = await this.apiClient.stopRecording(
        this.currentSession.id,
      );
      if (!response.success) {
        throw new Error(response.error?.message ?? "Failed to stop recording");
      }

      ctx.complete("success");
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  async presignWhiteboardUpload(
    roomId: string,
    fileId: string,
    mimeType: string,
  ): Promise<{ uploadUrl: string; expiresAtMs: number }> {
    const ctx = wideEvents.start("whiteboard.presign_upload");
    ctx.set("input", { roomId, fileId, mimeType });

    try {
      const response = await this.apiClient.presignWhiteboardUpload(
        roomId,
        fileId,
        mimeType,
      );
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? "Failed to presign upload");
      }

      ctx.complete("success");
      return response.data;
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  async presignWhiteboardDownload(
    roomId: string,
    fileId: string,
  ): Promise<{ downloadUrl: string; expiresAtMs: number }> {
    const ctx = wideEvents.start("whiteboard.presign_download");
    ctx.set("input", { roomId, fileId });

    try {
      const response = await this.apiClient.presignWhiteboardDownload(
        roomId,
        fileId,
      );
      if (!response.success || !response.data) {
        throw new Error(
          response.error?.message ?? "Failed to presign download",
        );
      }

      ctx.complete("success");
      return response.data;
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  get session(): ConferenceSession | null {
    return this.currentSession;
  }

  get room(): ConferenceSession | null {
    return this.session;
  }

  get isConnected(): boolean {
    return this.currentSession?.connectionState === "connected";
  }

  get connectionState(): SessionConnectionState {
    return this.currentSession?.connectionState ?? "disconnected";
  }

  async removeParticipant(apiParticipantId: string): Promise<void> {
    const ctx = wideEvents.start("participant.remove");

    try {
      if (!this.currentSession) {
        throw new Error("Not connected to a room");
      }

      ctx.set("input", {
        roomId: this.currentSession.id,
        participantId: apiParticipantId,
      });

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(apiParticipantId)) {
        throw new Error(
          `Invalid participant ID format: "${apiParticipantId}". Use customParticipantId from the participant object.`,
        );
      }

      if (apiParticipantId === this.currentSession.localParticipant?.id) {
        throw new Error("Cannot remove yourself from the room");
      }

      const response = await this.apiClient.removeParticipant(
        this.currentSession.id,
        apiParticipantId,
      );
      if (!response.success) {
        throw new Error(
          response.error?.message ?? "Failed to remove participant",
        );
      }

      ctx.complete("success");
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  disconnect(): void {
    const ctx = wideEvents.start("room.leave");

    if (this.currentSession) {
      this.trackPostHogLeave("disconnect");
      void this.currentSession.leave();
      this.currentSession = null;
    }

    if (this.currentWsClient) {
      this.currentWsClient.disconnect();
      this.currentWsClient = null;
    }

    ctx.complete("success");
  }
}
