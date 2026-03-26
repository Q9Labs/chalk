import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { APIClient } from "../api-client.ts";
import { ConferenceSession } from "../room.ts";
import { getRtkJoinPolicyForCurrentCohort } from "../rtk-join-policy.ts";
import { createSessionTokenProvider } from "../token-provider.ts";
import type { ChalkError, JoinSessionConfig, Participant, TokenProvider } from "../types.ts";
import { wideEvents } from "../wide-events/index.ts";
import { WSClient } from "../ws-client.ts";

interface JoinConferenceSessionDeps {
  apiUrl: string;
  apiClient: APIClient;
  demoMode: boolean;
  wsUrl: string;
  debug: boolean;
  tokenProvider?: TokenProvider;
  isTokenExpired: (token: string) => boolean;
  emitTokenExpired: (error: ChalkError) => void;
  initRealtimeKitClient: (authToken: string, audio: boolean, video: boolean) => Promise<RealtimeKitClient>;
  joinRealtimeKitWithRetry: (rtkClient: RealtimeKitClient, joinPolicySelection: ReturnType<typeof getRtkJoinPolicyForCurrentCohort>) => Promise<void>;
}

export interface JoinConferenceSessionResult {
  session: ConferenceSession;
  wsClient: WSClient | null;
  participantId: string;
  role: "host" | "participant";
  roomId: string;
  roomCreated: boolean;
  shouldStartRecording: boolean;
}

export const joinConferenceSession = async (sessionId: string, config: JoinSessionConfig, deps: JoinConferenceSessionDeps): Promise<JoinConferenceSessionResult> => {
  const ctx = wideEvents.start("room.join");
  ctx.set("input", {
    roomId: sessionId,
    displayName: config.displayName,
    role: config.role,
    audio: config.audio,
    video: config.video,
  });

  try {
    ctx.markPhase("api");

    const response = deps.demoMode ? await deps.apiClient.demoJoin(sessionId, config.displayName) : await deps.apiClient.addParticipant(sessionId, config.displayName, config.role, config.metadata);

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to join room");
    }

    const { participantId, role, tokens, room: roomInfo } = response.data;
    ctx.set("api", { success: true, participantId, role });

    if (!tokens.rtcToken) {
      throw new Error("RealtimeKit token missing - API did not return rtcToken");
    }
    if (deps.isTokenExpired(tokens.rtcToken)) {
      ctx.set("api", { rtcTokenExpiredAtJoin: true });
    }

    deps.apiClient.setToken(tokens.accessToken);
    const sessionTokenProvider = createSessionTokenProvider({
      apiUrl: deps.apiUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    const mutableApiClient = deps.apiClient as APIClient & {
      setTokenProvider?: (tokenProvider?: TokenProvider) => void;
    };
    mutableApiClient.setTokenProvider?.(sessionTokenProvider);

    const localParticipant: Participant = {
      id: participantId,
      userId: participantId,
      displayName: config.displayName,
      role: role ?? "participant",
      isLocal: true,
      videoEnabled: config.video ?? false,
      audioEnabled: config.audio ?? false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
      metadata: config.metadata,
    };

    let wsClient: WSClient | null = null;
    if (deps.wsUrl) {
      wsClient = new WSClient(deps.wsUrl, {
        debug: deps.debug,
        tokenProvider: sessionTokenProvider,
      });
      wsClient.on("token.expired", (error) => {
        deps.emitTokenExpired(error);
      });
    }

    ctx.markPhase("rtk.init");
    const rtkClient = await deps.initRealtimeKitClient(tokens.rtcToken, config.audio ?? false, config.video ?? false);

    if (!rtkClient) {
      throw new Error("RealtimeKit init returned null/undefined client");
    }

    const session = new ConferenceSession(roomInfo.id, rtkClient, deps.debug, deps.apiClient);
    session._setLocalParticipant(localParticipant);
    session._setInfo(roomInfo);
    session._setTokens(tokens);
    session._setRoomCreated(response.data.roomCreated ?? false);
    session._setTenantConfig(response.data.tenantConfig ?? null);

    if (wsClient) {
      session.attachWsClient(wsClient);
    }

    ctx.markPhase("rtk.join");
    const rtkJoinPolicy = getRtkJoinPolicyForCurrentCohort();
    ctx.set("rtkJoinPolicy", rtkJoinPolicy);

    const rtkJoinPromise = deps.joinRealtimeKitWithRetry(rtkClient, rtkJoinPolicy);

    if (wsClient && tokens.accessToken) {
      wsClient.connect(tokens.accessToken, sessionId);
    }

    await rtkJoinPromise;

    wideEvents.setRoomId(roomInfo.id);
    wideEvents.setParticipantId(participantId);
    ctx.complete("success", {
      participantCount: session.participants.size,
      roomCreated: response.data.roomCreated,
    });

    return {
      session,
      wsClient,
      participantId,
      role: role ?? "participant",
      roomId: roomInfo.id,
      roomCreated: response.data.roomCreated ?? false,
      shouldStartRecording: response.data.shouldStartRecording ?? false,
    };
  } catch (error) {
    ctx.complete("error", error);
    throw error;
  }
};
