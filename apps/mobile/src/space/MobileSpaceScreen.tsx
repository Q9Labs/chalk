import { Chalk, Entrance, type EntranceSettings } from "@q9labsai/chalk-react-native";
import type { ConnectionSlice } from "@q9labsai/chalk-client";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cleanupParticipantCredential, createAccessGrantGetter, prepareParticipantCredential, spaceInviteLink, type ParticipantCredential, type SpaceRoute } from "../lib/spaces";
import { getMobileFeedbackEvidence } from "../lib/mobile-feedback";
import { createMobileTelemetry, flushAndDisposeTelemetry } from "../lib/telemetry";
import { pickMobileChatFiles } from "../lib/chat-files";
import { MOBILE_SPACE_FEATURES } from "./mobile-space-features";
import { createMobileSpaceClient, createMobileSpaceRelease, ownMobileSpaceClient } from "./mobile-space-client";
import { recordMobileSpaceJoined, terminalizeMobileSpaceJourney } from "./mobile-space-telemetry-lifecycle";

type MobileSpaceScreenProps = {
  readonly brokerUrl: string;
  readonly defaultDisplayName?: string | null;
  readonly onClose: () => Promise<void>;
  readonly onDiagnosticsConnection?: (snapshot: Pick<ConnectionSlice, "status" | "lastError"> | null) => void;
  readonly onDiagnosticsFailure?: (error: { readonly message: string }) => void;
  readonly route: SpaceRoute;
  readonly telemetryEnabled: boolean;
};

type Arrival = {
  readonly credential: ParticipantCredential;
  readonly displayName: string;
  readonly defaults: Pick<EntranceSettings, "camera" | "microphone">;
  readonly journey: TelemetryJourney | undefined;
};

export function MobileSpaceScreen({ brokerUrl, defaultDisplayName, onClose, onDiagnosticsConnection, onDiagnosticsFailure, route, telemetryEnabled }: MobileSpaceScreenProps): React.JSX.Element {
  const feedbackEvidence = useMemo(() => getMobileFeedbackEvidence(), []);
  const telemetryApiBaseURLRef = useRef<string | undefined>(undefined);
  const authenticatedTelemetryHeadersRef = useRef<Readonly<Record<string, string>> | undefined>(undefined);
  const telemetry = useMemo(
    () =>
      createMobileTelemetry({
        enabled: telemetryEnabled,
        getApiBaseURL: () => telemetryApiBaseURLRef.current,
        getAuthenticatedTelemetryHeaders: () => authenticatedTelemetryHeadersRef.current,
      }),
    [telemetryEnabled],
  );
  const journeyRef = useRef<TelemetryJourney | undefined>(undefined);
  const arrivalRef = useRef<Arrival | undefined>(undefined);
  const cleanupPromisesRef = useRef(new Map<string, Promise<void>>());
  const isClosingRef = useRef(false);
  const episodeEndedRef = useRef(false);
  const isMountedRef = useRef(false);
  const [arrival, setArrival] = useState<Arrival>();
  const [arrivalError, setArrivalError] = useState<string>();
  const [isPreparing, setIsPreparing] = useState(false);
  arrivalRef.current = arrival;

  useEffect(() => {
    episodeEndedRef.current = false;
    const journey = telemetry.startJourney({
      kind: "space.join",
      attributes: { source: route.source },
    });
    authenticatedTelemetryHeadersRef.current = undefined;
    Object.assign(journey, {
      setAuthenticatedTelemetryHeaders: (headers: Readonly<Record<string, string>> | undefined) => {
        authenticatedTelemetryHeadersRef.current = headers;
      },
    });
    journey.phase("authentication");
    journeyRef.current = journey;

    return () => {
      terminalizeMobileSpaceJourney(journey, "unmounted");
      authenticatedTelemetryHeadersRef.current = undefined;
      if (journeyRef.current === journey) journeyRef.current = undefined;
      void telemetry.flush();
    };
  }, [route.source, telemetry]);

  useEffect(
    () => () => {
      void flushAndDisposeTelemetry(telemetry);
    },
    [telemetry],
  );

  const cleanupCredential = useCallback(
    (credential: ParticipantCredential): Promise<void> => {
      const key = credential.participantCredentialId;
      const existing = cleanupPromisesRef.current.get(key);
      if (existing) return existing;

      const cleanup = cleanupParticipantCredential({
        brokerUrl,
        credential,
        headers: journeyRef.current?.headers,
      })
        .then(() => {
          authenticatedTelemetryHeadersRef.current = undefined;
        })
        .catch((cause: unknown) => {
          onDiagnosticsFailure?.(cause instanceof Error ? cause : new Error("Unable to clear access."));
          throw cause;
        })
        .finally(() => {
          if (cleanupPromisesRef.current.get(key) === cleanup) cleanupPromisesRef.current.delete(key);
        });
      cleanupPromisesRef.current.set(key, cleanup);
      return cleanup;
    },
    [brokerUrl, onDiagnosticsFailure],
  );
  const cleanupCredentialRef = useRef(cleanupCredential);
  cleanupCredentialRef.current = cleanupCredential;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      const credential = arrivalRef.current?.credential;
      if (!credential || isClosingRef.current) return;

      terminalizeMobileSpaceJourney(journeyRef.current, "unmounted");
      void cleanupCredentialRef.current(credential).catch(() => undefined);
    };
  }, []);

  const closeSpace = useMemo(
    () =>
      createMobileSpaceRelease({
        cleanupCredential,
        onClose,
        onReleaseFailure: () => {
          isClosingRef.current = false;
        },
        onReleaseStart: () => {
          isClosingRef.current = true;
          terminalizeMobileSpaceJourney(journeyRef.current, "left");
        },
      }),
    [cleanupCredential, onClose],
  );

  const prepareArrival = useCallback(
    async (settings: EntranceSettings) => {
      setArrivalError(undefined);
      setIsPreparing(true);
      try {
        const credential = await prepareParticipantCredential({
          brokerUrl,
          displayName: settings.displayName,
          headers: journeyRef.current?.headers,
          spaceInviteToken: route.spaceInviteToken,
        });
        if (isClosingRef.current || !isMountedRef.current) {
          await cleanupCredential(credential);
          return;
        }
        telemetryApiBaseURLRef.current = credential.apiBaseURL;
        void telemetry.flush();
        setArrival({ credential, defaults: { camera: settings.camera, microphone: settings.microphone }, displayName: settings.displayName, journey: journeyRef.current });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error("Unable to prepare access.");
        setArrivalError(error.message);
        onDiagnosticsFailure?.(error);
      } finally {
        setIsPreparing(false);
      }
    },
    [brokerUrl, cleanupCredential, onDiagnosticsFailure, route.spaceInviteToken, telemetry],
  );

  const getAccess = useMemo(
    () =>
      arrival
        ? createAccessGrantGetter({
            brokerUrl,
            credential: arrival.credential,
            headers: journeyRef.current?.headers,
          })
        : undefined,
    [arrival, brokerUrl],
  );

  const client = useMemo(
    () =>
      arrival && getAccess
        ? createMobileSpaceClient({
            credential: arrival.credential,
            defaults: arrival.defaults,
            getAccess,
            journey: arrival.journey,
            space: route.space,
          })
        : undefined,
    [arrival, getAccess, route.space],
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

  const handleJoined = useCallback(() => {
    recordMobileSpaceJoined(journeyRef.current);
    void telemetry.flush();
  }, [telemetry]);

  const handleEpisodeEnded = useCallback(() => {
    if (episodeEndedRef.current) return;
    episodeEndedRef.current = true;
    terminalizeMobileSpaceJourney(journeyRef.current, "episode_ended");
    void telemetry.flush();
    void closeSpace(arrivalRef.current?.credential).catch(() => undefined);
  }, [closeSpace, telemetry]);

  const handleError = useCallback(
    ({ error }: { readonly error: Error }) => {
      if (episodeEndedRef.current) return;
      terminalizeMobileSpaceJourney(journeyRef.current, "error");
      void telemetry.flush();
      onDiagnosticsFailure?.(error);
    },
    [onDiagnosticsFailure, telemetry],
  );

  const handleEntranceCancel = useCallback(() => {
    void closeSpace().catch(() => undefined);
  }, [closeSpace]);

  const handleLeft = useCallback(() => {
    if (!arrival) return;
    void telemetry.flush();
    void closeSpace(arrival.credential).catch(() => undefined);
  }, [arrival, closeSpace, telemetry]);

  if (!arrival || !client) {
    return <Entrance defaultDisplayName={defaultDisplayName ?? undefined} defaults={{ camera: true, microphone: true }} error={arrivalError} joining={isPreparing} onCancel={handleEntranceCancel} onJoin={prepareArrival} spaceName={route.spaceName ?? "Space"} />;
  }

  return (
    <Chalk
      client={client}
      defaults={arrival.defaults}
      displayName={arrival.displayName}
      entrance={false}
      features={MOBILE_SPACE_FEATURES}
      feedbackEvidence={feedbackEvidence}
      inviteLink={spaceInviteLink(arrival.credential.spaceInviteToken)}
      onEpisodeEnded={handleEpisodeEnded}
      onError={handleError}
      onJoined={handleJoined}
      onLeft={handleLeft}
      pickChatFiles={pickMobileChatFiles}
      spaceName={route.spaceName ?? "Space"}
    />
  );
}
