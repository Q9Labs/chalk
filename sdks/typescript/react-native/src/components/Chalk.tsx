import type { ClientEventMap, GetAccess, SpaceClient } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ChalkProvider, useSpaceClient } from "../context/space-client-context";
import { useConnection } from "../hooks/space-hooks";
import { createNativeSpaceClient } from "../space-client/create-native-space-client";
import { NativeThemeProvider, useNativeTheme } from "../ui/native-theme";
import { DEFAULT_CHALK_THEME_TOKENS } from "../ui/theme-tokens";
import { SpaceView } from "./SpaceView";
import { Entrance, type EntranceDefaults } from "./Entrance";

export type ChalkFeatures = {
  readonly chat?: boolean;
  readonly participants?: boolean;
  readonly admission?: boolean;
  readonly screenShare?: boolean;
  readonly whiteboard?: boolean;
  readonly reactions?: boolean;
  readonly handRaise?: boolean;
  readonly info?: boolean;
  readonly settings?: boolean;
};

export const CHALK_THEME_TOKENS = DEFAULT_CHALK_THEME_TOKENS;

export type ChalkThemeTokens = {
  readonly [Token in keyof typeof CHALK_THEME_TOKENS]: string;
};

export type ChalkTheme = {
  readonly colorScheme?: "dark" | "light";
  readonly accent?: string;
  readonly tokens?: Partial<ChalkThemeTokens>;
};

export type SpaceLayout = "grid" | "focus" | "presentation";

type ChalkCallbacks = {
  readonly onJoined?: () => void;
  readonly onLeft?: () => void;
  readonly onEpisodeEnded?: (event: ClientEventMap["episodeEnded"]) => void;
  readonly onParticipantJoined?: (event: ClientEventMap["participantJoined"]) => void;
  readonly onParticipantLeft?: (event: ClientEventMap["participantLeft"]) => void;
  readonly onScreenShareStarted?: (event: ClientEventMap["screenShareStarted"]) => void;
  readonly onScreenShareStopped?: (event: ClientEventMap["screenShareStopped"]) => void;
  readonly onError?: (event: ClientEventMap["error"]) => void;
};

type ChalkCommonProps = ChalkCallbacks & {
  readonly displayName?: string;
  readonly entrance?: boolean;
  readonly defaults?: EntranceDefaults;
  readonly features?: ChalkFeatures;
  readonly theme?: ChalkTheme;
  readonly logoUrl?: string;
  readonly spaceName?: string;
  readonly inviteLink?: string;
  readonly layout?: SpaceLayout;
  readonly onLayoutChange?: (layout: SpaceLayout) => void;
};

export type ChalkProps = ChalkCommonProps &
  (
    | {
        readonly client: SpaceClient;
        readonly space?: never;
        readonly getAccess?: never;
      }
    | {
        readonly client?: never;
        readonly space: string;
        readonly getAccess: GetAccess;
      }
  );

export function Chalk(props: ChalkProps): React.JSX.Element {
  const suppliedClient = props.client;
  const space = props.space;
  const getAccess = props.getAccess;
  const getAccessRef = useRef(getAccess);
  getAccessRef.current = getAccess;
  const defaults = useRef(props.defaults).current;
  const getLatestAccess = useCallback((...args: Parameters<GetAccess>): ReturnType<GetAccess> => {
    const currentGetAccess = getAccessRef.current;
    if (!currentGetAccess) throw new Error("Chalk requires getAccess when it creates the SpaceClient.");
    return currentGetAccess(...args);
  }, []);
  const ownedClient = useMemo(
    () =>
      suppliedClient
        ? null
        : createNativeSpaceClient({
            space: space!,
            getAccess: getLatestAccess,
            microphone: defaults?.microphone,
            camera: defaults?.camera,
          }),
    [getLatestAccess, space, suppliedClient],
  );
  const client = suppliedClient ?? ownedClient!;

  useEffect(() => {
    if (!ownedClient) return;
    return () => {
      void ownedClient
        .leave()
        .catch(() => undefined)
        .finally(() => ownedClient.dispose());
    };
  }, [ownedClient]);

  return (
    <NativeThemeProvider theme={props.theme}>
      <ChalkProvider client={client}>
        <SpaceExperience {...props} />
      </ChalkProvider>
    </NativeThemeProvider>
  );
}

function SpaceExperience(props: ChalkProps): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
  const previousStatus = useRef(connection.status);
  const hasObservedStatus = useRef(false);
  const hasBeenLive = useRef(connection.status === "live" || connection.status === "reconnecting");
  const autoJoinAttempted = useRef(false);
  const previousClient = useRef(client);
  const [joinError, setJoinError] = useState<string | null>(null);

  if (previousClient.current !== client) {
    previousClient.current = client;
    previousStatus.current = connection.status;
    hasObservedStatus.current = false;
    hasBeenLive.current = connection.status === "live" || connection.status === "reconnecting";
    autoJoinAttempted.current = false;
  }

  const entrance = props.entrance ?? true;
  const spaceName = props.spaceName ?? props.space ?? "Space";
  const join = useCallback(
    async (options: Parameters<SpaceClient["join"]>[0]) => {
      try {
        setJoinError(null);
        await client.join(options);
      } catch (cause) {
        setJoinError(cause instanceof Error ? cause.message : "Could not enter this Space.");
      }
    },
    [client],
  );
  const retryAutomaticJoin = useCallback(() => {
    autoJoinAttempted.current = true;
    void join(defaultJoinOptions(props));
  }, [join, props]);

  useEffect(() => {
    setJoinError(null);
  }, [client]);

  useEffect(() => {
    const subscriptions = [
      props.onEpisodeEnded && client.on("episodeEnded", props.onEpisodeEnded),
      props.onParticipantJoined && client.on("participantJoined", props.onParticipantJoined),
      props.onParticipantLeft && client.on("participantLeft", props.onParticipantLeft),
      props.onScreenShareStarted && client.on("screenShareStarted", props.onScreenShareStarted),
      props.onScreenShareStopped && client.on("screenShareStopped", props.onScreenShareStopped),
      props.onError && client.on("error", props.onError),
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [client, props.onEpisodeEnded, props.onError, props.onParticipantJoined, props.onParticipantLeft, props.onScreenShareStarted, props.onScreenShareStopped]);

  useEffect(() => {
    if (!entrance && connection.status === "idle" && !autoJoinAttempted.current) {
      autoJoinAttempted.current = true;
      void join(defaultJoinOptions(props));
    }
  }, [connection.status, entrance, join, props.defaults?.camera, props.defaults?.microphone, props.displayName]);

  useEffect(() => {
    const previous = previousStatus.current;
    if (hasObservedStatus.current) {
      if (connection.status === "live" && previous !== "live" && previous !== "reconnecting") props.onJoined?.();
      if (connection.status === "left" && previous !== "left") props.onLeft?.();
    }
    previousStatus.current = connection.status;
    hasObservedStatus.current = true;
    if (connection.status === "live" || connection.status === "reconnecting") hasBeenLive.current = true;
  }, [connection.status, props.onJoined, props.onLeft]);

  if (connection.status === "idle" && entrance) {
    return <Entrance defaultDisplayName={props.displayName} defaults={props.defaults} error={joinError ?? undefined} logoUrl={props.logoUrl} onJoin={join} spaceName={spaceName} />;
  }

  if (connection.status === "idle") {
    return <SpaceStatus message={joinError ?? `Entering ${spaceName}…`} onRetry={joinError ? retryAutomaticJoin : undefined} />;
  }

  if (connection.status === "joining") {
    if (!entrance) return <SpaceStatus message={`Entering ${spaceName}…`} />;
    return <Entrance defaultDisplayName={props.displayName} defaults={props.defaults} joining logoUrl={props.logoUrl} onJoin={join} spaceName={spaceName} />;
  }

  if (connection.status === "failed") {
    if (!hasBeenLive.current && entrance) {
      return <Entrance defaultDisplayName={props.displayName} defaults={props.defaults} error={connection.lastError?.message ?? "Unable to enter this Space."} logoUrl={props.logoUrl} onJoin={join} spaceName={spaceName} />;
    }
    return <SpaceStatus message={connection.lastError?.message ?? "This Space is unavailable."} onRetry={() => void join(defaultJoinOptions(props))} />;
  }

  if (connection.status === "leaving") return <SpaceStatus message={`Leaving ${spaceName}…`} />;
  if (connection.status === "left") return <SpaceStatus message="You have left this Space." onRetry={() => void join(defaultJoinOptions(props))} />;

  return <NativeSpaceView features={props.features} inviteLink={props.inviteLink} layout={props.layout} logoUrl={props.logoUrl} onLayoutChange={props.onLayoutChange} reconnecting={connection.status === "reconnecting"} spaceName={spaceName} />;
}

function defaultJoinOptions(props: ChalkProps): Parameters<SpaceClient["join"]>[0] {
  const displayName = props.displayName?.trim();
  return {
    ...(displayName ? { displayName } : {}),
    microphone: props.defaults?.microphone ?? true,
    camera: props.defaults?.camera ?? true,
  };
}

type NativeSpaceViewProps = {
  readonly features?: ChalkFeatures;
  readonly inviteLink?: string;
  readonly layout?: SpaceLayout;
  readonly logoUrl?: string;
  readonly onLayoutChange?: (layout: SpaceLayout) => void;
  readonly reconnecting: boolean;
  readonly spaceName: string;
};

function NativeSpaceView({ features, inviteLink, layout, logoUrl, onLayoutChange, reconnecting, spaceName }: NativeSpaceViewProps): React.JSX.Element {
  const client = useSpaceClient();
  const theme = useNativeTheme();

  return (
    <View style={[styles.space, { backgroundColor: theme.colors.background }]}>
      <SpaceView features={features} inviteLink={inviteLink} layout={layout} logoUrl={logoUrl} onEndEpisode={() => client.endEpisode()} onLayoutChange={onLayoutChange} onLeave={() => client.leave()} reconnecting={reconnecting} spaceName={spaceName} />
    </View>
  );
}

function SpaceStatus({ message, onRetry }: { readonly message: string; readonly onRetry?: () => void }): React.JSX.Element {
  const theme = useNativeTheme();
  return (
    <View accessibilityLiveRegion="polite" style={[styles.status, { backgroundColor: theme.colors.background }]}>
      <Text style={[styles.statusText, { color: theme.colors.foreground }]}>{message}</Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={[styles.retry, { backgroundColor: theme.colors.primary }]}>
          <Text style={[styles.retryText, { color: theme.colors.primaryForeground }]}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  space: { flex: 1 },
  status: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  statusText: { fontSize: 16, textAlign: "center" },
  retry: { borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12 },
  retryText: { fontWeight: "800" },
});
