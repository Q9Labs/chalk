import type { ConnectionSlice } from "@q9labsai/chalk-client";
import { Chalk, Entrance, type EntranceSettings } from "@q9labsai/chalk-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cleanupSpaceArrival, createGuestAccessGetter, prepareSpaceArrival, type MobileSpaceArrival, type SpaceOperationObserver, type SpaceRoute } from "../lib/spaces";
import { pickMobileChatFiles } from "../lib/chat-files";
import { MOBILE_SPACE_FEATURES } from "./mobile-space-features";
import { createMobileSpaceClient, createMobileSpaceRelease, ownMobileSpaceClient } from "./mobile-space-client";
type MobileSpaceScreenProps = {
  readonly apiBaseURL: string;
  readonly defaultDisplayName?: string | null;
  readonly onClose: () => Promise<void>;
  readonly onDiagnosticsConnection?: (snapshot: Pick<ConnectionSlice, "status" | "lastError"> | null) => void;
  readonly onDiagnosticsFailure?: (error: { readonly message: string }) => void;
  readonly onOperation?: SpaceOperationObserver;
  readonly route: SpaceRoute;
};
export function MobileSpaceScreen({ apiBaseURL, defaultDisplayName, onClose, onDiagnosticsConnection, onDiagnosticsFailure, onOperation, route }: MobileSpaceScreenProps): React.JSX.Element {
  const arrivalRef = useRef<MobileSpaceArrival | undefined>(undefined);
  const isClosingRef = useRef(false);
  const episodeEndedRef = useRef(false);
  const isMountedRef = useRef(false);
  const [arrival, setArrival] = useState<MobileSpaceArrival>();
  const [arrivalError, setArrivalError] = useState<string>();
  const [isPreparing, setIsPreparing] = useState(false);
  arrivalRef.current = arrival;
  const recordOperation = useCallback<SpaceOperationObserver>(
    (operation, state) => {
      onOperation?.(operation, state);
    },
    [onOperation],
  );
  useEffect(() => {
    isMountedRef.current = true;
    episodeEndedRef.current = false;
    if (route.source === "created-space") recordOperation("create", "succeeded");
    return () => {
      isMountedRef.current = false;
    };
  }, [recordOperation, route.source]);
  const closeSpace = useMemo(
    () =>
      createMobileSpaceRelease({
        cleanupCredential: (credential) => cleanupSpaceArrival({ apiBaseURL, credential, onOperation: recordOperation }),
        onClose,
        onReleaseFailure: () => {
          isClosingRef.current = false;
          recordOperation("leave", "failed");
        },
        onReleaseStart: () => {
          isClosingRef.current = true;
          recordOperation("leave", "observed");
        },
      }),
    [apiBaseURL, onClose, recordOperation],
  );
  const prepareArrival = useCallback(
    async (settings: EntranceSettings) => {
      setArrivalError(undefined);
      setIsPreparing(true);
      try {
        const nextArrival = await prepareSpaceArrival({ apiBaseURL, displayName: settings.displayName, onOperation: recordOperation, route });
        if (!isMountedRef.current || isClosingRef.current) {
          await cleanupSpaceArrival({ apiBaseURL, credential: nextArrival.credential, onOperation: recordOperation });
          return;
        }
        setArrival({ ...nextArrival, defaults: { camera: settings.camera, microphone: settings.microphone }, displayName: settings.displayName });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error("Unable to join this Space.");
        setArrivalError(error.message);
        onDiagnosticsFailure?.(error);
      } finally {
        setIsPreparing(false);
      }
    },
    [apiBaseURL, onDiagnosticsFailure, recordOperation, route],
  );
  const getAccess = useMemo(() => (arrival ? createGuestAccessGetter({ apiBaseURL, credential: arrival.credential, initialAccess: arrival.access, onOperation: recordOperation }) : undefined), [apiBaseURL, arrival, recordOperation]);
  const client = useMemo(
    () =>
      arrival && getAccess
        ? createMobileSpaceClient({
            apiBaseURL,
            defaults: arrival.defaults,
            getAccess,
            space: route.space,
          })
        : undefined,
    [apiBaseURL, arrival, getAccess, route.space],
  );
  const clientOwner = useMemo(() => (client ? ownMobileSpaceClient(client) : undefined), [client]);
  useEffect(() => {
    if (!clientOwner) return;
    return () => {
      void clientOwner.release();
    };
  }, [clientOwner]);
  useEffect(() => {
    if (!client) {
      onDiagnosticsConnection?.(null);
      return;
    }
    const publishConnection = () => {
      const { connection } = client.getSnapshot();
      onDiagnosticsConnection?.({ status: connection.status, lastError: connection.lastError });
    };
    publishConnection();
    const unsubscribe = client.subscribe(publishConnection);
    return () => {
      unsubscribe();
      onDiagnosticsConnection?.(null);
    };
  }, [client, onDiagnosticsConnection]);
  const handleJoined = useCallback(() => {}, []);
  const handleEpisodeEnded = useCallback(() => {
    if (episodeEndedRef.current) return;
    episodeEndedRef.current = true;
    void closeSpace(arrivalRef.current?.credential).catch((cause: unknown) => {
      onDiagnosticsFailure?.(cause instanceof Error ? cause : new Error("Unable to leave this Space."));
    });
  }, [closeSpace, onDiagnosticsFailure]);
  const handleError = useCallback(
    ({ error }: { readonly error: Error }) => {
      if (episodeEndedRef.current) return;
      onDiagnosticsFailure?.(error);
    },
    [onDiagnosticsFailure],
  );
  const handleEntranceCancel = useCallback(() => {
    void closeSpace().catch((cause: unknown) => {
      onDiagnosticsFailure?.(cause instanceof Error ? cause : new Error("Unable to leave this Space."));
    });
  }, [closeSpace, onDiagnosticsFailure]);
  const handleLeft = useCallback(() => {
    if (!arrival) return;
    void closeSpace(arrival.credential).catch((cause: unknown) => {
      onDiagnosticsFailure?.(cause instanceof Error ? cause : new Error("Unable to leave this Space."));
    });
  }, [arrival, closeSpace, onDiagnosticsFailure]);
  if (!arrival || !client) {
    return <Entrance defaultDisplayName={defaultDisplayName ?? undefined} defaults={{ camera: true, microphone: true }} error={arrivalError} joining={isPreparing} onCancel={handleEntranceCancel} onJoin={prepareArrival} spaceName={route.spaceName ?? route.space} />;
  }
  return (
    <Chalk
      client={client}
      defaults={arrival.defaults}
      displayName={arrival.displayName}
      entrance={false}
      features={MOBILE_SPACE_FEATURES}
      inviteLink={route.inviteLink}
      onEpisodeEnded={handleEpisodeEnded}
      onError={handleError}
      onJoined={handleJoined}
      onLeft={handleLeft}
      pickChatFiles={pickMobileChatFiles}
      spaceName={route.spaceName ?? arrival.spaceName}
    />
  );
}
