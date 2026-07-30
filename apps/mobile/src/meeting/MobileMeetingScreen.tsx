import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChalkSessionAccessProvider, ChalkSessionStore } from "@q9labsai/chalk-client";
import { NativeVideoConference, ChalkClientSessionError, createChalkClientSession, createChalkNativeSession, type ChalkClientSession, type NativeJoinSettings, type NativeVideoConferenceDiagnosticsSnapshot } from "@q9labsai/chalk-react-native";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clearClientSessionCredential, loadClientSessionCredential, saveClientSessionCredential, type LobbyRoute } from "../lib/chalk";
import { pickAndUploadChatAttachments } from "../lib/chat-attachments";
import { createMobileTelemetry, flushAndDisposeTelemetry } from "../lib/telemetry";
import { MOBILE_MEETING_FEATURES } from "./mobile-meeting-features";
import { recordMobileMeetingJoined, terminalizeMobileMeetingJourney } from "./mobile-meeting-telemetry-lifecycle";

export interface MeetingScreenProps {
  readonly route: LobbyRoute;
  readonly onClose: () => Promise<void>;
  readonly brokerUrl: string;
  readonly onDiagnosticsChange?: (snapshot: NativeVideoConferenceDiagnosticsSnapshot) => void;
  readonly onDiagnosticsError?: (error: { message: string }) => void;
  readonly onSessionChange?: (session: ChalkSessionStore | null) => void;
}

export function MobileMeetingScreen({ route, onClose, brokerUrl, onDiagnosticsChange, onDiagnosticsError, onSessionChange }: MeetingScreenProps): React.JSX.Element {
  const telemetryAccessRef = useRef<{ readonly apiBaseURL: string; readonly token: string } | undefined>(undefined);
  const telemetry = useMemo(
    () =>
      createMobileTelemetry({
        enabled: true,
        getAccess: () => telemetryAccessRef.current,
      }),
    [],
  );
  const journeyRef = useRef<TelemetryJourney | undefined>(undefined);
  const clientSessionRef = useRef<ChalkClientSession | null>(null);
  const [journey, setJourney] = useState<TelemetryJourney | undefined>(undefined);
  const [meetingLink, setMeetingLink] = useState<string | undefined>(undefined);

  useEffect(() => {
    const nextJourney = telemetry.startJourney({
      kind: "meeting.join",
      attributes: { role: route.role, source: route.source },
    });
    nextJourney.phase("authentication");
    journeyRef.current = nextJourney;
    setJourney(nextJourney);

    return () => {
      terminalizeMobileMeetingJourney(nextJourney, "unmounted");
      if (journeyRef.current === nextJourney) journeyRef.current = undefined;
      void telemetry.flush();
    };
  }, [route.role, route.source, telemetry]);

  useEffect(
    () => () => {
      void flushAndDisposeTelemetry(telemetry);
    },
    [telemetry],
  );

  const createSession = useCallback(
    async (settings: NativeJoinSettings): Promise<ChalkSessionStore> => {
      const storedCredential = !clientSessionRef.current && route.joinToken ? await loadClientSessionCredential(route.joinToken) : undefined;
      const create = (credential = storedCredential) =>
        createChalkClientSession({
          brokerBaseURL: brokerUrl,
          displayName: settings.displayName,
          meetingBaseURL: "https://chalkmeet.com",
          telemetry: journey,
          ...(clientSessionRef.current ? { credential: clientSessionRef.current } : credential ? { credential } : route.joinToken ? { inviteToken: route.joinToken } : {}),
        });
      let clientSession: ChalkClientSession;
      try {
        clientSession = await create();
      } catch (error) {
        if (!storedCredential || !(error instanceof ChalkClientSessionError) || ![401, 404, 410].includes(error.status)) {
          throw error;
        }
        await clearClientSessionCredential(storedCredential.inviteToken);
        clientSession = await create(undefined);
      }
      clientSessionRef.current = clientSession;
      setMeetingLink(clientSession.meetingLink);
      await saveClientSessionCredential(clientSession);
      const access: ChalkSessionAccessProvider = async (request) => {
        const participantAccess = await clientSession.access(request);
        telemetryAccessRef.current = {
          apiBaseURL: clientSession.apiBaseURL,
          token: participantAccess.sync.token,
        };
        return participantAccess;
      };
      return createChalkNativeSession({
        access,
        apiBaseURL: clientSession.apiBaseURL,
        syncURL: clientSession.syncURL,
        initialMicrophoneEnabled: settings.audioEnabled,
        initialCameraEnabled: settings.videoEnabled,
        storage: AsyncStorage,
        telemetry: journey,
      });
    },
    [brokerUrl, journey, route.joinToken],
  );

  const handleJoin = useCallback(() => {
    recordMobileMeetingJoined(journeyRef.current);
    void telemetry.flush();
  }, [telemetry]);

  const handleError = useCallback(
    (error: { message: string }) => {
      terminalizeMobileMeetingJourney(journeyRef.current, "error");
      void telemetry.flush();
      onDiagnosticsError?.(error);
    },
    [onDiagnosticsError, telemetry],
  );

  const handleEnd = useCallback(() => {
    terminalizeMobileMeetingJourney(journeyRef.current, "meeting_ended");
    void telemetry.flush();
  }, [telemetry]);

  const cleanupClientSession = useCallback(async () => {
    const clientSession = clientSessionRef.current;
    clientSessionRef.current = null;
    telemetryAccessRef.current = undefined;
    if (!clientSession) return;
    try {
      await clientSession.cleanup();
    } finally {
      await clearClientSessionCredential(clientSession.inviteToken);
    }
  }, []);

  const handleClose = useCallback(async () => {
    terminalizeMobileMeetingJourney(journeyRef.current, "meeting_closed");
    void telemetry.flush();
    await cleanupClientSession().catch((error: unknown) => {
      onDiagnosticsError?.({
        message: error instanceof Error ? error.message : "The client session could not be cleaned up",
      });
    });
    await onClose();
  }, [cleanupClientSession, onClose, onDiagnosticsError, telemetry]);

  if (!journey) return <></>;

  return (
    <NativeVideoConference
      autoJoin={false}
      createSession={createSession}
      features={MOBILE_MEETING_FEATURES}
      initialPhase="lobby"
      meetingLink={meetingLink}
      onClose={() => void handleClose()}
      onDiagnosticsChange={onDiagnosticsChange}
      onEnd={handleEnd}
      onError={handleError}
      onJoin={handleJoin}
      onSessionChange={onSessionChange}
      pickChatAttachments={pickAndUploadChatAttachments}
      roomId={route.roomId}
      roomName={route.roomName}
      role={route.role}
      telemetry={journey}
      userName={route.role === "host" ? "Host" : "Guest"}
    />
  );
}
