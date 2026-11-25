import type { AdmissionPolicyTarget, Capability, ChatAttachment, ChatSendInput, ChatUploadFile, ClientEventHandler, ClientEventName, MediaRequestKind, OfflineActionsPolicy, Reaction, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { createPreviewMediaDevices } from "./preview-devices";
import { createPreviewAudioPlayback } from "./preview-audio-playback";
import { applyPreviewCommand, createPreviewChatMessage, createPreviewReaction } from "./preview-command-projection";
import { callEvents, createSpaceClient } from "@q9labsai/chalk-client";
export { PREVIEW_DEVICE_FIXTURES } from "./preview-devices";

export type PreviewClientCommand =
  | { readonly type: "join" }
  | { readonly type: "leave" }
  | { readonly type: "endEpisode" }
  | { readonly type: "extendEpisode"; readonly minutes: number }
  | { readonly type: "setMicrophoneEnabled"; readonly enabled: boolean }
  | { readonly type: "setCameraEnabled"; readonly enabled: boolean }
  | { readonly type: "setScreenShareEnabled"; readonly enabled: boolean }
  | { readonly type: "startRecording"; readonly recordingId: string }
  | { readonly type: "stopRecording" }
  | { readonly type: "selectMicrophone"; readonly deviceId: string }
  | { readonly type: "selectCamera"; readonly deviceId: string }
  | { readonly type: "selectSpeaker"; readonly deviceId: string }
  | { readonly type: "acceptRequest"; readonly requestId: string }
  | { readonly type: "declineRequest"; readonly requestId: string }
  | { readonly type: "assignRole"; readonly participantId: string; readonly roleName: string }
  | { readonly type: "mute"; readonly participantId: string }
  | { readonly type: "stopVideo"; readonly participantId: string }
  | { readonly type: "stopScreenShare"; readonly participantId: string }
  | { readonly type: "requestMedia"; readonly participantId: string; readonly kind: MediaRequestKind; readonly requestId: string }
  | { readonly type: "remove"; readonly participantId: string }
  | { readonly type: "admit"; readonly requestId: string }
  | { readonly type: "deny"; readonly requestId: string }
  | { readonly type: "setAdmissionPolicy"; readonly policy: AdmissionPolicyTarget }
  | { readonly type: "raiseHand" }
  | { readonly type: "lowerHand" }
  | { readonly type: "renameSelf"; readonly displayName: string }
  | { readonly type: "sendReaction"; readonly reaction: Reaction }
  | { readonly type: "reactToMessage"; readonly input: import("@q9labsai/chalk-client").ChatReactionInput }
  | { readonly type: "sendChat"; readonly input: ChatSendInput }
  | { readonly type: "markChatRead"; readonly messageId: string };

export type PreviewClientCommandUpdater = (snapshot: SpaceSnapshot, command: PreviewClientCommand) => SpaceSnapshot;
export type PreviewClientCommandObserver = (command: PreviewClientCommand, snapshot: SpaceSnapshot) => void;
export type PreviewClientOptions = {
  /** Replaces the default local command projection when a gallery needs custom URL state. */
  readonly updateCommand?: PreviewClientCommandUpdater;
  /** Observes commands after the local snapshot has been published. */
  readonly onCommand?: PreviewClientCommandObserver;
};

export type PreviewClient = SpaceClient & {
  readonly setSnapshot: (snapshot: SpaceSnapshot) => void;
  readonly updateSnapshot: (update: (snapshot: SpaceSnapshot) => SpaceSnapshot) => void;
  readonly dispatch: (command: PreviewClientCommand) => Promise<void>;
};

/**
 * Local stand-in client for URL-addressable previews and fixtures. Commands
 * project into the local snapshot and never open a network connection.
 */
export function createPreviewClient(initialSnapshot = createSnapshot(), options: PreviewClientOptions = {}): PreviewClient {
  let snapshot = initialSnapshot;
  let requestSequence = 0;
  let attachmentSequence = 0;
  let recordingSequence = 0;
  const listeners = new Set<() => void>();
  const callEventHandlers = new Set<ClientEventHandler<"callEvent">>();
  let cameraPreviewClient: SpaceClient | undefined;

  const setSnapshot = (nextSnapshot: SpaceSnapshot): void => {
    const previous = snapshot;
    snapshot = nextSnapshot;
    for (const listener of listeners) listener();
    for (const event of callEvents(previous, nextSnapshot)) for (const handler of callEventHandlers) handler({ event });
  };
  const updateSnapshot = (update: (current: SpaceSnapshot) => SpaceSnapshot): void => setSnapshot(update(snapshot));
  const dispatch = async (command: PreviewClientCommand): Promise<void> => {
    const nextSnapshot = (options.updateCommand ?? applyPreviewCommand)(snapshot, command);
    setSnapshot(nextSnapshot);
    options.onCommand?.(command, nextSnapshot);
  };

  const audioPlayback = createPreviewAudioPlayback((blocked) => updateSnapshot((current) => (current.media.audioPlayback.blocked === blocked ? current : { ...current, media: { ...current.media, audioPlayback: { blocked } } })));
  const dispose = (): void => {
    audioPlayback.dispose();
    cameraPreviewClient?.dispose();
    listeners.clear();
    callEventHandlers.clear();
  };
  const client = {
    media: {
      observeAudioElement: audioPlayback.observeAudioElement,
      observeAudioContext: audioPlayback.observeAudioContext,
      resumeAudioPlayback: audioPlayback.resumeAudioPlayback,
      captureCameraPreview: async () => {
        const current = snapshot.media.local.camera.track;
        if (snapshot.media.local.camera.state === "enabled" && current?.enabled && current.readyState === "live") return { track: current, release: () => {} };
        cameraPreviewClient ??= createSpaceClient({
          space: "camera-preview",
          getAccess: async () => {
            throw new Error("Preview capture must not join a call");
          },
        });
        const selected = snapshot.media.selection.camera;
        if (selected) await cameraPreviewClient.media.selectCamera(selected);
        const track = await cameraPreviewClient.media.captureCameraPreview();
        const devices = cameraPreviewClient.getSnapshot().media.devices;
        updateSnapshot((current) => ({ ...current, media: { ...current.media, devices } }));
        return track;
      },
      setMicrophoneEnabled: (enabled: boolean) => dispatch({ type: "setMicrophoneEnabled", enabled }),
      setCameraEnabled: (enabled: boolean) => dispatch({ type: "setCameraEnabled", enabled }),
      setScreenShareEnabled: (enabled: boolean) => dispatch({ type: "setScreenShareEnabled", enabled }),
      selectMicrophone: (deviceId: string) => dispatch({ type: "selectMicrophone", deviceId }),
      selectCamera: (deviceId: string) => dispatch({ type: "selectCamera", deviceId }),
      selectSpeaker: (deviceId: string) => dispatch({ type: "selectSpeaker", deviceId }),
      acceptRequest: (requestId: string) => dispatch({ type: "acceptRequest", requestId }),
      declineRequest: (requestId: string) => dispatch({ type: "declineRequest", requestId }),
    },
    chat: {
      react: async (input: import("@q9labsai/chalk-client").ChatReactionInput) => {
        await dispatch({ type: "reactToMessage", input });
        const message = snapshot.chat.messages.find((message) => message.messageId === input.messageId);
        return { messageId: input.messageId, revision: message?.reactionRevision ?? "0", reactions: message?.reactions ?? [] };
      },
      files: {
        upload: async (file: ChatUploadFile) => {
          const fileName = "name" in file ? file.name : file.fileName;
          const byteLength = "size" in file ? file.size : file.bytes.byteLength;
          const attachment: ChatAttachment = { attachmentId: `preview-attachment-${++attachmentSequence}`, fileName, mimeType: "text/plain", byteLength };
          return attachment;
        },
        url: (attachment: ChatAttachment) => `preview://attachment/${attachment.attachmentId}`,
        resolveUrl: async (attachment: ChatAttachment) => `preview://attachment/${attachment.attachmentId}`,
      },
      send: async (input: ChatSendInput) => {
        const message = createPreviewChatMessage(snapshot, input);
        await dispatch({ type: "sendChat", input });
        return message;
      },
      loadOlder: async () => ({ status: "loaded", count: 0, hasOlder: snapshot.chat.pagination.hasOlder }),
      markRead: async (messageId: string) => {
        await dispatch({ type: "markChatRead", messageId });
        return null;
      },
    },
    participants: {
      assignRole: (participantId: string, roleName: string) => dispatch({ type: "assignRole", participantId, roleName }),
      mute: (participantId: string) => dispatch({ type: "mute", participantId }),
      stopVideo: (participantId: string) => dispatch({ type: "stopVideo", participantId }),
      stopScreenShare: (participantId: string) => dispatch({ type: "stopScreenShare", participantId }),
      requestMedia: async (participantId: string, kind: MediaRequestKind) => {
        const requestId = `preview-media-request-${++requestSequence}`;
        await dispatch({ type: "requestMedia", participantId, kind, requestId });
        return { status: "delivered", requestId };
      },
      remove: (participantId: string) => dispatch({ type: "remove", participantId }),
      admit: (requestId: string) => dispatch({ type: "admit", requestId }),
      deny: (requestId: string) => dispatch({ type: "deny", requestId }),
      setAdmissionPolicy: (policy: AdmissionPolicyTarget) => dispatch({ type: "setAdmissionPolicy", policy }),
      raiseHand: () => dispatch({ type: "raiseHand" }),
      lowerHand: () => dispatch({ type: "lowerHand" }),
      renameSelf: (displayName: string) => dispatch({ type: "renameSelf", displayName }),
    },
    reactions: {
      send: async (reaction: Reaction) => {
        const active = createPreviewReaction(snapshot, reaction);
        await dispatch({ type: "sendReaction", reaction });
        return active;
      },
    },
    recording: {
      start: async () => {
        const recordingId = `preview-recording-${++recordingSequence}`;
        await dispatch({ type: "startRecording", recordingId });
        return { recordingId };
      },
      stop: () => dispatch({ type: "stopRecording" }),
    },
    offline: {
      send: async () => updateSnapshot((current) => ({ ...current, offline: { ...current.offline, pending: [], decisionNeeded: false } })),
      discard: async () => updateSnapshot((current) => ({ ...current, offline: { ...current.offline, pending: [], decisionNeeded: false } })),
      setPolicy: async (policy: OfflineActionsPolicy) => updateSnapshot((current) => ({ ...current, offline: { ...current.offline, policy } })),
    },
    whiteboard: { transport: () => null },
    telemetry: { sessionId: "", problemReported: () => undefined, renderCrashed: () => undefined },
    join: () => dispatch({ type: "join" }),
    leave: () => dispatch({ type: "leave" }),
    close: async () => dispose(),
    dispose,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    endEpisode: () => dispatch({ type: "endEpisode" }),
    extendEpisode: (minutes: number) => dispatch({ type: "extendEpisode", minutes }),
    // Only call events are real: a preview announces what a snapshot change would announce in a live call.
    on: <TEvent extends ClientEventName>(event: TEvent, handler: ClientEventHandler<TEvent>) => {
      if (event !== "callEvent") return () => undefined;
      const callEventHandler = handler as ClientEventHandler<"callEvent">;
      callEventHandlers.add(callEventHandler);
      return () => callEventHandlers.delete(callEventHandler);
    },
  } satisfies SpaceClient;

  return Object.assign(client, { setSnapshot, updateSnapshot, dispatch });
}

export function createSnapshot(capabilities: readonly Capability[] = ["sendChat"]): SpaceSnapshot {
  return {
    connection: { status: "idle", episode: null, lastError: null, episodeEnded: false, removedByHost: false, timedOut: false },
    self: { participantId: null, displayName: null, role: null, capabilities, handRaised: false, can: (capability) => capabilities.includes(capability) },
    participants: { roster: [], admissionQueue: [], admissionPolicy: null },
    media: {
      devices: {
        ...createPreviewMediaDevices(),
      },
      selection: { microphone: "preview-microphone", camera: "preview-camera", speaker: "preview-speaker" },
      local: { microphone: { source: "microphone", state: "disabled", track: null }, camera: { source: "camera", state: "disabled", track: null }, screen: { source: "screen", state: "disabled", track: null } },
      remote: [],
      screenShare: { source: "screen", state: "disabled", track: null },
      incomingRequests: [],
      audioPlayback: { blocked: false },
    },
    chat: { status: "idle", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    recording: { current: null },
    offline: { pending: [], decisionNeeded: false, policy: "ask" },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, presenting: false, error: null }, access: { canDraw: false, policy: null, permissions: [] } },
  };
}
