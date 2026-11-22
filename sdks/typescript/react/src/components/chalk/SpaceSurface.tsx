"use client";
import { screenAnnotationFor, type ChalkWhiteboardV1Transport, type ChalkWhiteboardView, type ClientFailure } from "@q9labsai/chalk-client";
import { preloadWhiteboardStylesheet } from "@q9labsai/chalk-whiteboard/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import { useCan, useCanDrawWhiteboard, useConnection, useMedia, useParticipants, useSelf, useSpaceClient, useWhiteboard } from "../../bindings/hooks";
import { useWhiteboardSceneSubscription } from "../../internal/useWhiteboardSceneSubscription";
import type { ChalkColorScheme } from "../../theme";
import { fromWhiteboardWireElement, toWhiteboardCollaborationEvent } from "../../whiteboard/wire-adapters";
import { commandFailure, type MediaCommandAction, type MediaCommandSource } from "../control-bar/command-failure";
import { SpaceView } from "../space-view/SpaceView";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import type { ChalkProps } from "./Chalk";

export function SpaceSurface(
  props: ChalkProps & {
    readonly resolvedColorScheme: ChalkColorScheme;
    readonly spaceName: string;
    readonly onOpenReport?: () => void;
    readonly onRetry: () => void;
  },
): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
  const media = useMedia();
  const whiteboardState = useWhiteboard();
  const canEndEpisode = useCan("endEpisode");
  const canDrawWhiteboard = useCanDrawWhiteboard();
  const self = useSelf();
  const { roster } = useParticipants();
  const setup = props.screenAnnotation;
  const whiteboardTransport = client.whiteboard.transport();
  const uploadsAvailable = whiteboardState.uploadsAvailable ?? Boolean(whiteboardTransport?.files.uploadFile);
  const screenAnnotation = useMemo(() => {
    if (!setup || !self.participantId || connection.status !== "live") return undefined;
    const canSave = props.features?.whiteboard !== false && canDrawWhiteboard;
    const context = {
      actorId: self.participantId,
      actorName: self.displayName ?? "You",
      grants: whiteboardState.access.policy === null ? undefined : whiteboardState.access.permissions,
      board: uploadsAvailable && whiteboardTransport ? { client, transport: whiteboardTransport, allowSave: canSave } : undefined,
      people: roster.map((person) => ({
        id: person.participantId,
        name: person.displayName,
        roleCanDraw: person.capabilities.includes("drawWhiteboard"),
        managesPolicy: person.capabilities.includes("manageWhiteboard"),
      })),
    };
    return {
      ...setup,
      client: screenAnnotationFor(client),
      context,
      publicationForTrack: (track: MediaStreamTrack) => (media.screenShare.track === track ? media.screenShare.publicationId : media.remote.find((item) => item.track === track && item.source === "screen")?.publicationId),
      actions: {
        saveToWhiteboard: canSave ? setup.actions?.saveToWhiteboard : undefined,
        downloadPng: setup.actions?.downloadPng,
      },
    };
  }, [setup, self.participantId, self.displayName, connection.status, whiteboardState.access, roster, client, media.remote, media.screenShare, canDrawWhiteboard, uploadsAvailable, whiteboardTransport, props.features?.whiteboard]);
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
              uploadFile: whiteboardSubscription.transport.files.uploadFile,
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
      screenAnnotation={screenAnnotation}
      onToggleWhiteboard={canDrawWhiteboard && setWhiteboardPresentation ? () => void runCommand(() => setWhiteboardPresentation(!whiteboardState.engine.presenting)) : undefined}
      onLeft={() => runCommand(() => client.leave())}
      onEndEpisode={canEndEpisode ? () => runCommand(() => client.endEpisode()) : undefined}
      onRejoin={props.onRejoin ?? props.onRetry}
      overlay={
        media.microphoneMutedByOtherDevice ? (
          <div role="status" className="pointer-events-none absolute inset-x-3 top-16 z-40 flex justify-center">
            <p className="chalk-toast text-center text-sm">Mic off: your other device is using it.</p>
          </div>
        ) : undefined
      }
    />
  );
}
function bindWhiteboardPresentation(transport: ChalkWhiteboardV1Transport): ((presenting: boolean) => Promise<void>) | undefined {
  const setPresentation = transport.setPresentation;
  if (!setPresentation) return undefined;
  return (presenting) => setPresentation.call(transport, presenting);
}
