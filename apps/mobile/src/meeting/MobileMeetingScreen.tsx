import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SpaceClient } from "@q9labsai/chalk-client";
import { VideoConference, ClientSessionError, createClientSession, createChalkSession, type ClientSession, type PreJoinSettings, type VideoConferenceDiagnosticsSnapshot } from "@q9labsai/chalk-react-native";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cleanupClientSession, clearClientSessionCredential, loadClientSessionCredential, saveClientSessionCredential, type LobbyRoute } from "../lib/chalk";
import { pickAndUploadChatAttachments } from "../lib/chat-attachments";
import { createMobileTelemetry, flushAndDisposeTelemetry } from "../lib/telemetry";
import { MOBILE_MEETING_FEATURES } from "./mobile-meeting-features";
import { recordMobileMeetingJoined, terminalizeMobileMeetingJourney } from "./mobile-meeting-telemetry-lifecycle";

export interface MeetingScreenProps {
  readonly route: LobbyRoute;
  readonly onClose: () => Promise<void>;
  readonly brokerUrl: string;
  readonly onDiagnosticsChange?: (snapshot: VideoConferenceDiagnosticsSnapshot) => void;
  readonly onDiagnosticsError?: (error: { message: string }) => void;
  readonly onSessionChange?: (client: Pick<SpaceClient, "leave"> | null) => void;
}

export function MobileMeetingScreen({ route, onClose, brokerUrl, onDiagnosticsChange, onDiagnosticsError, onSessionChange }: MeetingScreenProps): React.JSX.Element {
  const telemetry = useMemo(() => createMobileTelemetry({ enabled: true }), []);
  const journeyRef = useRef<TelemetryJourney | undefined>(undefined);
  const clientSessionRef = useRef<ClientSession | null>(null);
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
    async (settings: PreJoinSettings) => {
      const storedCredential = !clientSessionRef.current && route.joinToken ? await loadClientSessionCredential(route.joinToken) : undefined;
      const create = (credential = storedCredential) =>
        createClientSession({
          brokerBaseURL: brokerUrl,
          displayName: settings.displayName,
          meetingBaseURL: "https://chalkmeet.com",
          telemetry: journey,
          ...(clientSessionRef.current ? { credential: clientSessionRef.current } : credential ? { credential } : route.joinToken ? { inviteToken: route.joinToken } : {}),
        });
      let clientSession: ClientSession;
      try {
        clientSession = await create();
      } catch (error) {
        if (!storedCredential || !(error instanceof ClientSessionError) || ![401, 404, 410].includes(error.status)) {
          throw error;
        }
        await clearClientSessionCredential(storedCredential.inviteToken);
        clientSession = await create(undefined);
      }
      clientSessionRef.current = clientSession;
      setMeetingLink(clientSession.meetingLink);
      await saveClientSessionCredential(clientSession);
      return createChalkSession({
        getAccess: clientSession.access,
        apiBaseURL: clientSession.apiBaseURL,
        syncURL: clientSession.syncURL,
        initialMicrophoneEnabled: settings.microphoneEnabled,
        initialCameraEnabled: settings.cameraEnabled,
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

  const cleanupCurrentClientSession = useCallback(async () => {
    const clientSession = clientSessionRef.current;
    clientSessionRef.current = null;
    if (clientSession) await cleanupClientSession(clientSession);
  }, []);

  const handleError = useCallback(
    (error: { message: string }) => {
      terminalizeMobileMeetingJourney(journeyRef.current, "error");
      void telemetry.flush();
      onDiagnosticsError?.(error);
      void cleanupCurrentClientSession().catch((cause: unknown) => {
        onDiagnosticsError?.({
          message: cause instanceof Error ? cause.message : "The client session could not be cleaned up",
        });
      });
    },
    [cleanupCurrentClientSession, onDiagnosticsError, telemetry],
  );

  const handleEnd = useCallback(() => {
    terminalizeMobileMeetingJourney(journeyRef.current, "meeting_ended");
    void telemetry.flush();
  }, [telemetry]);

  const handleClose = useCallback(async () => {
    terminalizeMobileMeetingJourney(journeyRef.current, "meeting_closed");
    void telemetry.flush();
    await cleanupCurrentClientSession().catch((error: unknown) => {
      onDiagnosticsError?.({
        message: error instanceof Error ? error.message : "The client session could not be cleaned up",
      });
    });
    await onClose();
  }, [cleanupCurrentClientSession, onClose, onDiagnosticsError, telemetry]);

  if (!journey) return <></>;

  return (
    <VideoConference
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
