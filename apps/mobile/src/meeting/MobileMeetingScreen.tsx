import { ChalkNativeProvider, NativeVideoConference, useSession, type NativeVideoConferenceDiagnosticsSnapshot } from "@q9labsai/chalk-react-native";
import { recordWideEvent } from "@q9labsai/chalk-react-native/diagnostics";
import { useEffect, useMemo } from "react";
import type { LobbyRoute } from "../lib/chalk";

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

  return (
    <ChalkNativeProvider apiUrl={apiUrl} debug={diagnosticsEnabled} tokenProvider={tokenProvider} wideEvents={wideEvents} wsUrl={wsUrl}>
      <MeetingDiagnosticsBridge onSessionChange={onSessionChange} />
      <NativeVideoConference
        autoJoin={false}
        callKit={true}
        features={meetingFeatures}
        initialPhase="lobby"
        onClose={onClose}
        onDiagnosticsChange={onDiagnosticsChange}
        onError={onDiagnosticsError}
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
