"use client";
import { commandFailure, type MediaCommandAction, type MediaCommandSource } from "../control-bar/command-failure";
import { CallLimbo } from "../call-limbo/CallLimbo";
import { createSpaceClient, type ClientFailure, type ChalkWhiteboardV1Transport, type ChalkWhiteboardView, type ChatUploadFile, type ClientEventMap, type GetAccess, type JoinOptions, type SpaceClient } from "@q9labsai/chalk-client";
import { preloadWhiteboardStylesheet } from "@q9labsai/chalk-whiteboard/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ChalkProvider } from "../../bindings/context";
import { useCan, useCanDrawWhiteboard, useConnection, useMedia, useRecording, useSpaceClient, useWhiteboard } from "../../bindings/hooks";
import { chalkThemeStyle, type ChalkColorScheme, type ChalkTheme } from "../../theme";
import { useWhiteboardSceneSubscription } from "../../internal/useWhiteboardSceneSubscription";
import { fromWhiteboardWireElement, toWhiteboardCollaborationEvent } from "../../whiteboard/wire-adapters";
import { MediaRequestDialog } from "../media-request-dialog/MediaRequestDialog";
import { SpaceView, type SpaceViewProps } from "../space-view/SpaceView";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import { StatusSurface } from "./StatusSurface";
import { CallDialog } from "../space-header/CallDetails";
import { ShellStyles } from "../control-bar/ShellStyles";
export type SpaceLayout = "focus" | "grid";
export type ChalkFeatures = {
  readonly chat?: boolean;
  readonly participants?: boolean;
  readonly admission?: boolean;
  readonly screenShare?: boolean;
  readonly recording?: boolean;
  readonly whiteboard?: boolean;
  readonly reactions?: boolean;
  readonly handRaise?: boolean;
  /** Join / leave / message / hand-raise / reaction cues. */
  readonly sounds?: boolean;
};
type SpaceIntegration =
  | {
      readonly client: SpaceClient;
      readonly space?: never;
      readonly getAccess?: never;
    }
  | {
      readonly client?: never;
      readonly space: string;
      readonly getAccess: GetAccess;
    };
type SpaceEventCallbacks = {
  readonly onJoined?: () => void;
  readonly onLeft?: () => void;
  readonly onEpisodeEnded?: (event: ClientEventMap["episodeEnded"]) => void;
  readonly onParticipantJoined?: (event: ClientEventMap["participantJoined"]) => void;
  readonly onParticipantLeft?: (event: ClientEventMap["participantLeft"]) => void;
  readonly onScreenShareStarted?: (event: ClientEventMap["screenShareStarted"]) => void;
  readonly onScreenShareStopped?: (event: ClientEventMap["screenShareStopped"]) => void;
  readonly onError?: (event: ClientEventMap["error"]) => void;
};
export type ChalkProps = SpaceIntegration &
  SpaceEventCallbacks & {
    readonly defaults?: {
      readonly microphone?: boolean;
      readonly camera?: boolean;
    };
    readonly displayName?: string;
    readonly features?: ChalkFeatures;
    readonly theme?: ChalkTheme;
    readonly shareUrl?: string;
    readonly onReportProblem?: import("../space-header/SpaceHeader").SpaceHeaderProps["onReportProblem"];
    /** Opens an app-owned dialog that can outlive this call view. */
    readonly onOpenReportProblem?: () => void;
    /** Hides new report actions and disables Send without discarding an open report. */
    readonly reportUnavailableReason?: string;
    readonly onColorSchemeChange?: (colorScheme: ChalkColorScheme) => void;
    readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
    readonly spaceName?: string;
    readonly inviteLink?: string;
    /** Initial layout without a handler; controlled layout when onLayoutChange is supplied. */
    readonly layout?: SpaceLayout;
    readonly onLayoutChange?: (layout: SpaceLayout) => void;
    /** Rejoin on the page shown after leaving. Defaults to joining again with the same settings. */
    readonly onRejoin?: () => void;
    /** Home on the pages shown after the call. Without it the page has no Home action. */
    readonly onHome?: () => void;
    /** App-owned warning copy and actions for a call's duration limit. */
    readonly timeLimit?: SpaceViewProps["timeLimit"] & {
      readonly endAction?: { readonly label: string; readonly onClick: () => void };
    };
    /** Host-provided terminal reason when the transport cannot distinguish it. */
    readonly terminalState?: "removed" | "full" | "elsewhere";
  };
export function Chalk(props: ChalkProps): React.JSX.Element {
  const [localColorScheme, setLocalColorScheme] = useState<ChalkColorScheme>("dark");
  const colorScheme = props.theme?.colorScheme ?? localColorScheme;
  const changeColorScheme = (next: ChalkColorScheme) => {
    setLocalColorScheme(next);
    props.onColorSchemeChange?.(next);
  };
  const [reportOpen, setReportOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const openReport =
    props.onReportProblem && !props.reportUnavailableReason
      ? () => {
          if (props.onOpenReportProblem) props.onOpenReportProblem();
          else setReportOpen(true);
        }
      : undefined;
  const suppliedClient = props.client;
  const getAccessRef = useRef(props.getAccess);
  getAccessRef.current = props.getAccess;
  const getLatestAccess = useCallback<GetAccess>((context) => {
    const latestGetAccess = getAccessRef.current;
    if (!latestGetAccess) return Promise.reject(new Error("Chalk cannot refresh access after getAccess was removed."));
    return latestGetAccess(context);
  }, []);
  const ownedClient = useMemo(() => {
    if (suppliedClient) return null;
    if (!props.space || !getAccessRef.current) throw new Error("Chalk requires either client or both space and getAccess.");
    return createSpaceClient({ space: props.space, getAccess: getLatestAccess });
  }, [getLatestAccess, props.space, suppliedClient]);
  const client = suppliedClient ?? ownedClient!;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Leave and dispose only the client created by this component when ownership ends.
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
    <>
      <div ref={container} data-chalk data-chalk-theme={colorScheme} className="chalk-root h-full min-h-0 w-full" style={chalkThemeStyle(props.theme, colorScheme)}>
        <ChalkProvider client={client}>
          <SpaceExperience {...props} theme={{ ...props.theme, colorScheme }} onColorSchemeChange={changeColorScheme} resolvedColorScheme={colorScheme} onOpenReport={openReport} />
          {props.onReportProblem && !props.onOpenReportProblem ? (
            <>
              <ShellStyles />
              <CallDialog
                kind="report"
                open={reportOpen}
                onClose={() => setReportOpen(false)}
                onReportProblem={props.onReportProblem}
                unavailableReason={props.reportUnavailableReason}
                diagnostics={`Call: ${props.spaceName ?? props.space ?? "Call"}\nStatus: ${client.getSnapshot().connection.status}`}
                focusScope={container}
              />
            </>
          ) : null}
        </ChalkProvider>
      </div>
    </>
  );
}
function SpaceExperience(
  props: ChalkProps & {
    readonly resolvedColorScheme: ChalkColorScheme;
    readonly onOpenReport?: () => void;
  },
): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
  const recorded = useRecording().current?.status === "recording";
  const previousStatus = useRef(connection.status);
  const hasObservedStatus = useRef(false);
  const autoJoinAttempted = useRef(false);
  const [previousClient, setPreviousClient] = useState(client);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const [episodeEnded, setEpisodeEnded] = useState(false);
  const [handledTerminal, setHandledTerminal] = useState<ChalkProps["terminalState"]>(undefined);
  const [previousTerminal, setPreviousTerminal] = useState(props.terminalState);
  if (previousTerminal !== props.terminalState) {
    setPreviousTerminal(props.terminalState);
    setHandledTerminal(undefined);
  }
  const spaceName = props.spaceName ?? props.space ?? "Space";
  if (previousClient !== client) {
    setPreviousClient(client);
    setJoinError(null);
    setEpisodeEnded(false);
    previousStatus.current = connection.status;
    hasObservedStatus.current = false;
    autoJoinAttempted.current = false;
  }
  useClientEvents(client, props);
  const join = useCallback(
    async (settings: JoinOptions) => {
      try {
        setJoinError(null);
        await client.join(settings);
      } catch (cause) {
        setJoinError(cause instanceof Error ? cause.message : "Could not enter this Space.");
      }
    },
    [client],
  );
  const retryAutomaticJoin = useCallback(() => {
    autoJoinAttempted.current = true;
    setHandledTerminal(props.terminalState);
    setRetryPending(true);
    void join(defaultJoinOptions(props)).finally(() => setRetryPending(false));
  }, [join, props]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Track episodeEnded events for this client; return the client unsubscribe function.
  useEffect(
    () =>
      client.on("episodeEnded", () => {
        setEpisodeEnded(true);
      }),
    [client],
  );
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Start the automatic join once when the committed client becomes idle; the client owns join cancellation.
  useEffect(() => {
    if (connection.status !== "idle" || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    void join(defaultJoinOptions(props));
  }, [connection.status, join, props.defaults?.camera, props.defaults?.microphone, props.displayName]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [transition] Notify host callbacks of committed connection transitions, excluding reconnects and the initial snapshot.
  useEffect(() => {
    const previous = previousStatus.current;
    if (hasObservedStatus.current) {
      if (connection.status === "live" && previous !== "live" && previous !== "reconnecting") props.onJoined?.();
      if (connection.status === "left" && previous !== "left") props.onLeft?.();
    }
    previousStatus.current = connection.status;
    hasObservedStatus.current = true;
  }, [connection.status, props.onJoined, props.onLeft]);
  const callName = props.spaceName ?? props.space;
  const statusTheme = { ...props.theme, colorScheme: props.resolvedColorScheme };
  if (props.terminalState && props.terminalState !== handledTerminal) return <StatusSurface phase={props.terminalState} callName={callName} theme={statusTheme} onRejoin={props.onRejoin ?? retryAutomaticJoin} onHome={props.onHome} onReportProblem={props.onOpenReport} retryPending={retryPending} />;
  if (connection.status === "idle")
    return <CallLimbo theme={{ ...props.theme, colorScheme: props.resolvedColorScheme }} recorded={recorded} spaceName={spaceName} message={joinError ?? `Joining ${spaceName}…`} action={joinError ? { label: "Try again", onClick: retryAutomaticJoin, disabled: retryPending } : undefined} />;
  if (connection.status === "joining") return <CallLimbo theme={{ ...props.theme, colorScheme: props.resolvedColorScheme }} recorded={recorded} spaceName={spaceName} message={`Joining ${spaceName}…`} />;
  if (connection.status === "failed" && connection.lastError?.code === "episode.ended")
    return <StatusSurface phase="episode-ended" callName={callName} episodeEndReason={connection.episodeEndReason} endAction={props.timeLimit?.endAction} theme={statusTheme} onHome={props.onHome} onReportProblem={props.onOpenReport} />;
  if (connection.status === "failed") {
    return (
      <StatusSurface
        phase="failed"
        callName={callName}
        errorCode={connection.lastError?.code}
        reason={connection.lastError?.code === "access.invalid" ? connection.lastError.message : undefined}
        sync={connection.lastError?.sync}
        theme={statusTheme}
        onHome={props.onHome}
        onReportProblem={props.onOpenReport}
        onRetry={retryAutomaticJoin}
        retryPending={retryPending}
      />
    );
  }
  if (connection.status === "leaving" || connection.status === "left")
    return (
      <StatusSurface
        phase={episodeEnded || connection.episodeEnded ? "episode-ended" : "left"}
        episodeEndReason={connection.episodeEndReason}
        endAction={props.timeLimit?.endAction}
        callName={callName}
        theme={statusTheme}
        onReportProblem={connection.status === "leaving" ? undefined : props.onOpenReport}
        onRejoin={props.onRejoin ?? retryAutomaticJoin}
        rejoinDisabled={connection.status === "leaving" || retryPending}
        onHome={props.onHome}
      />
    );
  return (
    <div className="relative h-full min-h-0">
      <SpaceSurface {...props} spaceName={spaceName} />
      <CallLimbo overlay active={false} initiallyCovered message="" />
    </div>
  );
}
function SpaceSurface(
  props: ChalkProps & {
    readonly resolvedColorScheme: ChalkColorScheme;
    readonly spaceName: string;
    readonly onOpenReport?: () => void;
  },
): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
  const media = useMedia();
  const whiteboardState = useWhiteboard();
  const canEndEpisode = useCan("endEpisode");
  const canDrawWhiteboard = useCanDrawWhiteboard();
  const [commandError, setCommandError] = useState<string | ClientFailure | null>(() => (connection.lastError?.recoverable && connection.lastError.code.startsWith("media.") ? connection.lastError : null));
  const [commandSource, setCommandSource] = useState<MediaCommandSource>();
  const [commandAction, setCommandAction] = useState<MediaCommandAction>();
  const runCommand = useCallback(async (command: () => Promise<unknown>, source?: MediaCommandSource, action?: MediaCommandAction) => {
    try {
      await command();
      setCommandError(null);
      setCommandSource(undefined);
      setCommandAction(undefined);
    } catch (cause) {
      setCommandError(commandFailure(cause));
      setCommandSource(source);
      setCommandAction(action);
    }
  }, []);
  const whiteboardTransport = client.whiteboard.transport();
  const whiteboardAvailable = props.features?.whiteboard !== false;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Preload the whiteboard stylesheet only when the committed call supports a board.
  useEffect(() => {
    if (whiteboardAvailable) preloadWhiteboardStylesheet();
  }, [whiteboardAvailable]);
  const whiteboardSubscription = useWhiteboardSceneSubscription(whiteboardTransport, whiteboardAvailable);
  const setWhiteboardPresentation = whiteboardSubscription.status === "ready" ? bindWhiteboardPresentation(whiteboardSubscription.transport) : undefined;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [transition] Reconcile whiteboard loading/failure into command-error state without overriding a later command error on unrelated renders.
  useEffect(() => {
    if (whiteboardSubscription.status === "failed") setCommandError(whiteboardSubscription.error.message);
    else if (whiteboardSubscription.status === "loading" || whiteboardSubscription.status === "ready") setCommandError(null);
  }, [whiteboardSubscription]);
  const whiteboard =
    whiteboardAvailable && whiteboardState.engine.presenting && whiteboardSubscription.status === "ready"
      ? {
          isOpen: true,
          presenterId: whiteboardState.engine.presenterId,
          props: {
            canDraw: canDrawWhiteboard,
            collab: {
              canDraw: canDrawWhiteboard,
              subscribe: (listener: NonNullable<WhiteboardViewProps["collab"]>["subscribe"] extends (listener: infer T) => unknown ? T : never) => whiteboardSubscription.transport.subscribe((event) => listener(toWhiteboardCollaborationEvent(event))),
              submitUpdate: async (input: NonNullable<WhiteboardViewProps["collab"]>["submitUpdate"] extends (input: infer T) => unknown ? T : never) =>
                whiteboardSubscription.transport.submitUpdate({ sceneId: input.sceneId, syncAll: input.syncAll, elements: input.elements.map(fromWhiteboardWireElement) }),
              sendCursor: (input: NonNullable<WhiteboardViewProps["collab"]>["sendCursor"] extends (input: infer T) => unknown ? T : never) => whiteboardSubscription.transport.sendCursor(input),
              requestSnapshot: () => whiteboardSubscription.transport.requestSnapshot(),
              onSubmissionError: (cause: unknown) => setCommandError(cause instanceof Error ? cause.message : "Whiteboard could not sync."),
              clear: () => whiteboardSubscription.transport.clear(),
              presignDownload: (fileId: string) => whiteboardSubscription.transport.files.getDownloadUrl(fileId),
            },
          },
          sendView: (whiteboardSubscription.transport.supportsViews ?? Boolean(whiteboardSubscription.transport.sendView)) ? (view: ChalkWhiteboardView) => whiteboardSubscription.transport.sendView?.(view) ?? false : undefined,
        }
      : undefined;
  return (
    <SpaceView
      timeLimit={props.timeLimit}
      colorScheme={props.resolvedColorScheme}
      shareUrl={props.shareUrl}
      onReportProblem={props.onReportProblem}
      onOpenReportProblem={props.onOpenReport}
      reportUnavailableReason={props.reportUnavailableReason}
      onColorSchemeChange={props.onColorSchemeChange}
      spaceName={props.spaceName}
      inviteLink={props.inviteLink}
      pickChatFiles={props.pickChatFiles}
      commandError={commandError ?? undefined}
      commandSource={commandSource}
      commandAction={commandAction}
      onDismissCommandError={() => setCommandError(null)}
      layout={props.layout}
      onLayoutChange={props.onLayoutChange}
      features={props.features}
      whiteboard={whiteboard}
      onToggleWhiteboard={canDrawWhiteboard && setWhiteboardPresentation ? () => void runCommand(() => setWhiteboardPresentation(!whiteboardState.engine.presenting)) : undefined}
      onLeft={() => runCommand(() => client.leave())}
      onEndEpisode={canEndEpisode ? () => runCommand(() => client.endEpisode()) : undefined}
      reconnecting={{ isVisible: connection.status === "reconnecting", status: "reconnecting", showNotice: false }}
      overlay={
        <>
          {media.incomingRequests[0] ? (
            <MediaRequestDialog
              request={media.incomingRequests[0]}
              onDecline={() => void runCommand(() => client.media.declineRequest(media.incomingRequests[0]!.requestId), media.incomingRequests[0]!.kind === "start_camera" ? "camera" : "microphone", "request")}
              onAllow={() => void runCommand(() => client.media.acceptRequest(media.incomingRequests[0]!.requestId), media.incomingRequests[0]!.kind === "start_camera" ? "camera" : "microphone", "request")}
            />
          ) : null}
        </>
      }
    />
  );
}
function bindWhiteboardPresentation(transport: ChalkWhiteboardV1Transport): ((presenting: boolean) => Promise<void>) | undefined {
  const setPresentation = transport.setPresentation;
  if (!setPresentation) return undefined;
  return (presenting) => setPresentation.call(transport, presenting);
}
function defaultJoinOptions(props: ChalkProps): JoinOptions {
  const displayName = props.displayName?.trim();
  return { ...(displayName ? { displayName } : {}), microphone: props.defaults?.microphone ?? true, camera: props.defaults?.camera ?? true };
}
function useClientEvents(client: SpaceClient, callbacks: SpaceEventCallbacks): void {
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Forward participantJoined events to the current host callback; unsubscribe on replacement.
  useEffect(() => client.on("participantJoined", (event) => callbacks.onParticipantJoined?.(event)), [callbacks.onParticipantJoined, client]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Forward participantLeft events to the current host callback; unsubscribe on replacement.
  useEffect(() => client.on("participantLeft", (event) => callbacks.onParticipantLeft?.(event)), [callbacks.onParticipantLeft, client]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Forward episodeEnded events to the current host callback; unsubscribe on replacement.
  useEffect(() => client.on("episodeEnded", (event) => callbacks.onEpisodeEnded?.(event)), [callbacks.onEpisodeEnded, client]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Forward screenShareStarted events to the current host callback; unsubscribe on replacement.
  useEffect(() => client.on("screenShareStarted", (event) => callbacks.onScreenShareStarted?.(event)), [callbacks.onScreenShareStarted, client]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Forward screenShareStopped events to the current host callback; unsubscribe on replacement.
  useEffect(() => client.on("screenShareStopped", (event) => callbacks.onScreenShareStopped?.(event)), [callbacks.onScreenShareStopped, client]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Forward client errors to the current host callback; unsubscribe on replacement.
  useEffect(() => client.on("error", (event) => callbacks.onError?.(event)), [callbacks.onError, client]);
}
