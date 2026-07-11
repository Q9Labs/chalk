import { ChalkNativeProvider, NativeVideoConference, useSession, type NativeVideoConferenceDiagnosticsSnapshot } from "@q9labsai/chalk-react-native";
import { recordWideEvent } from "@q9labsai/chalk-react-native/diagnostics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LobbyRoute } from "../lib/chalk";
import { createMobileTelemetry, flushAndDisposeTelemetry } from "../lib/telemetry";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";
import { recordMobileMeetingJoined, terminalizeMobileMeetingJourney } from "./mobile-meeting-telemetry-lifecycle";

type ChalkSession = ReturnType<typeof useSession>;

export interface MeetingScreenProps {
  route: LobbyRoute;
  onClose: () => Promise<void>;
  apiUrl: string;
  wsUrl?: string;
  tokenProvider?: () => Promise<string>;
  diagnosticsEnabled: boolean;
  wideEvents?: { enabled?: boolean; includeDebugInfo?: boolean; handler?: typeof recordWideEvent };
  onDiagnosticsChange?: (snapshot: NativeVideoConferenceDiagnosticsSnapshot) => void;
  onDiagnosticsError?: (error: { message: string }) => void;
  onSessionChange?: (session: ChalkSession | null) => void;
}

export function MobileMeetingScreen({ route, onClose, apiUrl, wsUrl, tokenProvider, diagnosticsEnabled, wideEvents, onDiagnosticsChange, onDiagnosticsError, onSessionChange }: MeetingScreenProps): React.JSX.Element {
  const meetingFeatures = useMemo(() => ({ screenShare: true }), []);
  const telemetry = useMemo(() => createMobileTelemetry({ apiUrl, enabled: true, tokenProvider }), [apiUrl, tokenProvider]);
  const journeyRef = useRef<TelemetryJourney | undefined>(undefined);
  const [journey, setJourney] = useState<TelemetryJourney | undefined>(undefined);

  useEffect(() => {
    const journey = telemetry.startJourney({ kind: "meeting.join", attributes: { role: route.role, source: route.source } });
    journey.phase("authentication");
    journeyRef.current = journey;
    setJourney(journey);

    return () => {
      terminalizeMobileMeetingJourney(journey, "unmounted");
      if (journeyRef.current === journey) {
        journeyRef.current = undefined;
      }
      void telemetry.flush();
    };
  }, [route.role, route.source, telemetry]);

  useEffect(
    () => () => {
      void flushAndDisposeTelemetry(telemetry);
    },
    [telemetry],
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

  const handleClose = useCallback(() => {
    terminalizeMobileMeetingJourney(journeyRef.current, "meeting_closed");
    void telemetry.flush();
    void onClose();
  }, [onClose, telemetry]);

  if (!journey) {
    return <></>;
  }

  return (
    <ChalkNativeProvider apiUrl={apiUrl} debug={diagnosticsEnabled} telemetry={journey} tokenProvider={tokenProvider} wideEvents={wideEvents} wsUrl={wsUrl}>
      <MeetingDiagnosticsBridge onSessionChange={onSessionChange} />
      <NativeVideoConference
        autoJoin={false}
        callKit={true}
        features={meetingFeatures}
        initialPhase="lobby"
        onClose={handleClose}
        onDiagnosticsChange={onDiagnosticsChange}
        onEnd={handleEnd}
        onError={handleError}
        onJoin={handleJoin}
        roomId={route.roomId}
        roomName={route.roomName}
        role={route.role}
        userName={route.role === "host" ? "Host" : "Guest"}
      />
    </ChalkNativeProvider>
  );
}

function MeetingDiagnosticsBridge({ onSessionChange }: { onSessionChange?: (session: ChalkSession | null) => void }): null {
  const session = useSession();

  useEffect(() => {
    onSessionChange?.(session);
    return () => {
      onSessionChange?.(null);
    };
  }, [onSessionChange, session]);

  return null;
}
