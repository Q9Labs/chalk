import type {
  ActiveReaction,
  AdmissionRequest,
  Capability,
  ChatMessage,
  ChatReadReceipt,
  ChatSendInput,
  ChalkWhiteboardV1Element,
  ChalkWhiteboardV1Event,
  ChalkWhiteboardV1Transport,
  ClientEventHandler,
  ClientEventMap,
  ClientFailure,
  ConnectionStatus,
  LocalMedia,
  MediaSource,
  Participant,
  SpaceClient,
  SpaceSnapshot,
} from "@q9labsai/chalk-client";

import type { PreviewSearch, PreviewState } from "./preview-state";
import { PREVIEW_ADMISSION_REQUESTS, PREVIEW_CHAT_LINES, PREVIEW_DISPLAY_NAME } from "./sdk-preview-fixtures";

const PREVIEW_TIME = "2026-08-01T10:20:00.000Z";
const PREVIEW_EXPIRY = "2026-08-01T11:20:00.000Z";
const PREVIEW_EPISODE = { id: "preview-episode", startedAt: PREVIEW_TIME, deadline: PREVIEW_EXPIRY } as const;

const ALL_CAPABILITIES = [
  "publishAudio",
  "publishVideo",
  "publishScreen",
  "subscribe",
  "raiseHand",
  "renameSelf",
  "sendChat",
  "sendReaction",
  "drawWhiteboard",
  "manageWhiteboard",
  "manageAdmission",
  "assignRoles",
  "muteOthers",
  "stopVideoOthers",
  "stopScreenOthers",
  "requestMediaOthers",
  "removeParticipant",
  "endEpisode",
] as const satisfies readonly Capability[];

const PARTICIPANT_FIXTURES = [
  { id: "you", displayName: PREVIEW_DISPLAY_NAME, role: "owner", handRaised: false, capabilities: ALL_CAPABILITIES },
  { id: "nora", displayName: "Nora Williams", role: "collaborator", handRaised: false, capabilities: ["publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand"] as const },
  { id: "akash", displayName: "Akash Jain", role: "observer", handRaised: true, capabilities: ["publishAudio", "publishVideo", "subscribe", "raiseHand"] as const },
  { id: "sofia", displayName: "Sofia Chen", role: "observer", handRaised: false, capabilities: ["publishAudio", "publishVideo", "subscribe", "raiseHand"] as const },
  { id: "malik", displayName: "Malik Brooks", role: "observer", handRaised: false, capabilities: ["publishAudio", "publishVideo", "subscribe", "raiseHand"] as const },
] as const;

const PREVIEW_MESSAGES: readonly ChatMessage[] = PREVIEW_CHAT_LINES.map((line, index) => ({
  messageId: `preview-message-${index + 1}`,
  clientMessageId: `preview-client-${index + 1}`,
  sequence: String(index + 1),
  participantId: line.displayName === PREVIEW_DISPLAY_NAME ? "you" : line.displayName === "Nora Williams" ? "nora" : "sofia",
  displayName: line.displayName,
  text: line.text,
  createdAt: `2026-08-01T10:${12 + index}:00.000Z`,
  attachments: [],
}));

const PREVIEW_REACTIONS: readonly ActiveReaction[] = [
  {
    eventId: "preview-reaction-1",
    participantId: "nora",
    displayName: "Nora Williams",
    reaction: "🎉",
    occurredAt: "2026-08-01T10:15:00.000Z",
    expiresAt: "2026-08-01T10:16:00.000Z",
  },
];

type PreviewParticipant = Participant;

export function createPreviewStore(search: PreviewSearch): SpaceClient {
  let snapshot = createPreviewSnapshot(search);
  let disposed = false;
  const listeners = new Set<() => void>();
  const eventListeners = new Map<keyof ClientEventMap, Set<(event: never) => void>>();

  const update = (next: SpaceSnapshot | ((current: SpaceSnapshot) => SpaceSnapshot)): void => {
    if (disposed) return;
    snapshot = typeof next === "function" ? next(snapshot) : next;
    for (const listener of [...listeners]) listener();
  };

  const emit = <TEvent extends keyof ClientEventMap>(event: TEvent, payload: ClientEventMap[TEvent]): void => {
    for (const listener of eventListeners.get(event) ?? []) (listener as (value: ClientEventMap[TEvent]) => void)(payload);
  };

  const updateParticipants = (project: (participant: PreviewParticipant) => PreviewParticipant): void => {
    update((current) => ({ ...current, participants: { ...current.participants, roster: current.participants.roster.map(project) } }));
  };

  const updateLocalMedia = (source: MediaSource, state: LocalMedia["state"]): void => {
    update((current) => ({
      ...current,
      media: {
        ...current.media,
        local: { ...current.media.local, [source]: { ...current.media.local[source], state } },
        screenShare: source === "screen" ? { ...current.media.screenShare, state } : current.media.screenShare,
      },
    }));
  };

  const store: SpaceClient = {
    media: {
      setMicrophoneEnabled: async (enabled) => updateLocalMedia("microphone", enabled ? "enabled" : "disabled"),
      setCameraEnabled: async (enabled) => updateLocalMedia("camera", enabled ? "enabled" : "disabled"),
      setScreenShareEnabled: async (enabled) => updateLocalMedia("screen", enabled ? "enabled" : "disabled"),
      selectMicrophone: async () => undefined,
      selectCamera: async () => undefined,
      selectSpeaker: async () => undefined,
      acceptRequest: async (requestId) => update((current) => ({ ...current, media: { ...current.media, incomingRequests: current.media.incomingRequests.filter((request) => request.requestId !== requestId) } })),
      declineRequest: async (requestId) => update((current) => ({ ...current, media: { ...current.media, incomingRequests: current.media.incomingRequests.filter((request) => request.requestId !== requestId) } })),
    },
    chat: {
      files: {
        upload: async () => {
          throw new Error("File transfer is unavailable in the local Space fixture.");
        },
        url: (attachment) => `https://example.invalid/chat/${attachment.attachmentId}`,
      },
      send: async (input) => sendMessage(input),
      loadOlder: async () => {
        update((current) => ({ ...current, chat: { ...current.chat, pagination: { ...current.chat.pagination, hasOlder: false } } }));
        return { status: "loaded", count: 0, hasOlder: false };
      },
      markRead: async (messageId) => markRead(messageId),
    },
    participants: {
      assignRole: async (participantId, roleName) =>
        updateParticipants((participant) => (participant.participantId === participantId ? { ...participant, role: roleName, eligibleRoles: participant.eligibleRoles.includes(roleName) ? participant.eligibleRoles : [...participant.eligibleRoles, roleName] } : participant)),
      mute: async (participantId) => updateParticipantMedia(participantId, "microphone", "inactive"),
      stopVideo: async (participantId) => updateParticipantMedia(participantId, "camera", "inactive"),
      stopScreenShare: async (participantId) => updateParticipantMedia(participantId, "screenShare", "inactive"),
      requestMedia: async (participantId) => ({ status: "delivered", requestId: `preview-request-${participantId}` }),
      remove: async (participantId) => update((current) => ({ ...current, participants: { ...current.participants, roster: current.participants.roster.filter((participant) => participant.participantId !== participantId) } })),
      admit: async (requestId) => admitParticipant(requestId),
      deny: async (requestId) => update((current) => ({ ...current, participants: { ...current.participants, admissionQueue: current.participants.admissionQueue.filter((request) => request.requestId !== requestId) } })),
      raiseHand: async () => setHand(true),
      lowerHand: async () => setHand(false),
      renameSelf: async (displayName) => {
        update((current) => ({
          ...current,
          self: { ...current.self, displayName },
          participants: { ...current.participants, roster: current.participants.roster.map((participant) => (participant.participantId === "you" ? { ...participant, displayName } : participant)) },
        }));
      },
    },
    reactions: {
      send: async (reaction) => {
        const next: ActiveReaction = { eventId: `preview-reaction-${snapshot.reactions.active.length + 1}`, participantId: "you", displayName: snapshot.self.displayName ?? PREVIEW_DISPLAY_NAME, reaction, occurredAt: PREVIEW_TIME, expiresAt: PREVIEW_EXPIRY };
        update((current) => ({ ...current, reactions: { active: [...current.reactions.active, next] } }));
        return next;
      },
    },
    whiteboard: { transport: () => createPreviewWhiteboardTransport() },
    join: async () => {
      update(createPreviewSnapshot({ ...search, state: "happy" }));
    },
    leave: async () => update((current) => ({ ...current, connection: { status: "left", episode: null, lastError: null } })),
    dispose: () => {
      disposed = true;
      listeners.clear();
      eventListeners.clear();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    endEpisode: async () => {
      const previous = snapshot.connection.episode;
      update((current) => ({ ...current, connection: { status: "left", episode: previous, lastError: { code: "episode.ended", recoverable: false, message: "This Episode has ended." } } }));
      emit("episodeEnded", { episode: previous });
    },
    extendEpisode: async () => undefined,
    on: <TEvent extends keyof ClientEventMap>(event: TEvent, handler: ClientEventHandler<TEvent>) => {
      const handlers = eventListeners.get(event) ?? new Set<(value: never) => void>();
      handlers.add(handler as (value: never) => void);
      eventListeners.set(event, handlers);
      return () => handlers.delete(handler as (value: never) => void);
    },
  };

  return store;

  function setHand(raised: boolean): void {
    update((current) => ({
      ...current,
      self: { ...current.self, handRaised: raised },
      participants: { ...current.participants, roster: current.participants.roster.map((participant) => (participant.participantId === "you" ? { ...participant, handRaised: raised } : participant)) },
    }));
  }

  function updateParticipantMedia(participantId: string, source: keyof PreviewParticipant["media"], state: "active" | "inactive"): void {
    updateParticipants((participant) => (participant.participantId === participantId ? { ...participant, media: { ...participant.media, [source]: state } } : participant));
  }

  function sendMessage(input: ChatSendInput): ChatMessage {
    const sequence = snapshot.chat.messages.length + 1;
    const next = createMessage(input.text, "you", snapshot.self.displayName ?? PREVIEW_DISPLAY_NAME, sequence);
    update((current) => ({ ...current, chat: { ...current.chat, status: "ready", messages: [...current.chat.messages, next] } }));
    return next;
  }

  function markRead(messageId: string): ChatReadReceipt | null {
    const message = snapshot.chat.messages.find((candidate) => candidate.messageId === messageId);
    if (!message) return null;
    const receipt: ChatReadReceipt = { participantId: "you", participantGeneration: 1, readThroughSequence: message.sequence, readAt: PREVIEW_TIME };
    update((current) => ({ ...current, chat: { ...current.chat, unreadCount: 0, localReadThroughSequence: message.sequence, readReceipts: [...current.chat.readReceipts, receipt] } }));
    return receipt;
  }

  function admitParticipant(requestId: string): void {
    update((current) => {
      const request = current.participants.admissionQueue.find((candidate) => candidate.requestId === requestId);
      if (!request) return current;
      const participant: PreviewParticipant = {
        participantId: request.participantId,
        displayName: request.displayName,
        handRaised: false,
        role: request.initialRole,
        eligibleRoles: request.eligibleRoles,
        capabilities: ["publishAudio", "publishVideo", "subscribe", "raiseHand"],
        media: inactiveParticipantMedia(),
      };
      return { ...current, participants: { roster: [...current.participants.roster, participant], admissionQueue: current.participants.admissionQueue.filter((candidate) => candidate.requestId !== requestId) } };
    });
  }
}

export function createPreviewSnapshot(search: PreviewSearch): SpaceSnapshot {
  const lifecycle = lifecycleFor(search.state);
  const roster = participantsFor(search.participants, search);
  const admissionQueue: readonly AdmissionRequest[] =
    lifecycle.status === "left" || search.state === "empty" ? [] : PREVIEW_ADMISSION_REQUESTS.map((request) => ({ requestId: request.id, participantId: request.id, displayName: request.displayName, initialRole: "observer", eligibleRoles: ["collaborator", "observer"], expiresAt: PREVIEW_EXPIRY }));
  const microphone = localMediaFor("microphone", lifecycle, search.mic);
  const camera = localMediaFor("camera", lifecycle, search.camera);
  const screen = localMediaFor("screen", lifecycle, false);
  const self = roster.find((participant) => participant.participantId === "you");

  return {
    connection: { status: lifecycle.status, episode: lifecycle.status === "live" || lifecycle.status === "reconnecting" ? PREVIEW_EPISODE : null, lastError: lifecycle.failure },
    self: { participantId: self?.participantId ?? null, displayName: self?.displayName ?? null, role: self?.role ?? null, capabilities: self?.capabilities ?? [], handRaised: self?.handRaised ?? false, can: (capability) => Boolean(self?.capabilities.includes(capability)) },
    participants: { roster, admissionQueue },
    media: {
      devices: { microphones: [], cameras: [], speakers: [] },
      selection: { microphone: null, camera: null, speaker: null },
      local: { microphone, camera, screen },
      remote: [],
      screenShare: screen,
      incomingRequests: [],
    },
    chat: chatFor(search),
    reactions: { active: PREVIEW_REACTIONS },
    whiteboard: { open: search.stage === "whiteboard", engine: { status: "ready", sceneId: "preview-board", revision: "1", error: null } },
  };
}

function lifecycleFor(state: PreviewState): { readonly status: ConnectionStatus; readonly failure: ClientFailure | null } {
  switch (state) {
    case "reconnecting":
      return { status: "reconnecting", failure: null };
    case "retry":
      return { status: "live", failure: failureFor("connection.sync_recovery_exhausted", "The Space connection needs another try.") };
    case "warning":
      return { status: "live", failure: failureFor("connection.media_recovery_exhausted", "Some Space media needs another try.") };
    case "timeout":
      return { status: "failed", failure: failureFor("connection.sync_recovery_exhausted", "The Space took too long to reconnect.") };
    case "failure":
      return { status: "failed", failure: failureFor("connection.sync_start_failed", "The Space connection failed before recovery completed.") };
    case "ended":
      return { status: "left", failure: failureFor("episode.ended", "This Episode has ended.", false) };
    default:
      return { status: "live", failure: null };
  }
}

function failureFor(code: ClientFailure["code"], message: string, recoverable = true): ClientFailure {
  return { code, recoverable, message };
}

function participantsFor(count: PreviewSearch["participants"], search: PreviewSearch): readonly PreviewParticipant[] {
  return PARTICIPANT_FIXTURES.slice(0, count).map((fixture, index) => ({
    participantId: fixture.id,
    displayName: fixture.displayName,
    handRaised: index === 0 ? search.hand : fixture.handRaised,
    role: fixture.role,
    eligibleRoles: fixture.role === "owner" ? ["owner", "collaborator", "observer"] : ["collaborator", "observer"],
    capabilities: [...fixture.capabilities],
    media: participantMediaFor(fixture.id, search),
  }));
}

function localMediaFor(source: MediaSource, lifecycle: ReturnType<typeof lifecycleFor>, intended: boolean): LocalMedia {
  const state = lifecycle.status === "failed" ? (intended ? "failed" : "unavailable") : lifecycle.status === "live" || lifecycle.status === "reconnecting" ? (intended ? "enabled" : "disabled") : "unavailable";
  return { source, state, track: null };
}

function participantMediaFor(participantId: string, search: PreviewSearch): PreviewParticipant["media"] {
  if (participantId === "you") return { microphone: search.mic ? "active" : "inactive", camera: search.camera ? "active" : "inactive", screenShare: "inactive" };
  const fixture = PARTICIPANT_FIXTURES.find((candidate) => candidate.id === participantId);
  return { microphone: fixture && fixture.id !== "akash" ? "active" : "inactive", camera: fixture && fixture.id !== "akash" ? "active" : "inactive", screenShare: "inactive" };
}

function inactiveParticipantMedia(): PreviewParticipant["media"] {
  return { microphone: "inactive", camera: "inactive", screenShare: "inactive" };
}

function chatFor(search: PreviewSearch): SpaceSnapshot["chat"] {
  const pendingSends =
    search.chat === "pending"
      ? [{ clientMessageId: "preview-pending-1", text: "I’m sending the latest Space notes…", attachments: [], status: "sending" as const, error: null }]
      : search.chat === "failure"
        ? [{ clientMessageId: "preview-failed-1", text: "Could not publish this update", attachments: [], status: "failed" as const, error: failureFor("client.internal_error", "Chat is temporarily unavailable.") }]
        : [];
  return {
    status: search.chat === "loading" ? "loading" : search.chat === "failure" ? "failed" : "ready",
    messages: search.chat === "empty" || search.chat === "loading" || search.chat === "failure" ? [] : PREVIEW_MESSAGES,
    pendingSends,
    readReceipts: [],
    unreadCount: search.chat === "ready" || search.chat === "pending" ? 2 : 0,
    pagination: { cursor: null, hasOlder: search.chat === "loading", historyTruncated: false },
    lastError: search.chat === "failure" ? failureFor("client.internal_error", "Chat is temporarily unavailable.") : null,
  };
}

function createPreviewWhiteboardTransport(): ChalkWhiteboardV1Transport {
  const listeners = new Set<(event: ChalkWhiteboardV1Event) => void>();
  let elements: readonly ChalkWhiteboardV1Element[] = [];
  let revision = 1;
  const emitSnapshot = (): void => {
    const event: ChalkWhiteboardV1Event = { type: "snapshot", sceneId: "preview-board", revision: String(revision), elements };
    for (const listener of [...listeners]) listener(event);
  };
  const commit = (nextElements: readonly ChalkWhiteboardV1Element[]) => {
    elements = nextElements;
    revision += 1;
    const result = { operationId: `preview-whiteboard-${revision}`, sceneId: "preview-board", revision: String(revision) };
    const event: ChalkWhiteboardV1Event = { type: "update", sceneId: result.sceneId, revision: result.revision, elements };
    for (const listener of [...listeners]) listener(event);
    return result;
  };
  const unsupportedFileOperation = async (): Promise<never> => {
    throw new Error("File transfer is unavailable in the local Space fixture.");
  };

  return {
    startSceneSubscription: async () => emitSnapshot(),
    stopSceneSubscription: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submitUpdate: async (input) => commit(input.elements),
    sendCursor: () => undefined,
    requestSnapshot: async () => emitSnapshot(),
    clear: async () => commit([]),
    setDrawPermission: async () => undefined,
    files: {
      initiateUpload: unsupportedFileOperation,
      finalizeUpload: unsupportedFileOperation,
      getDownloadUrl: unsupportedFileOperation,
    },
  };
}

function createMessage(text: string, participantId: string, displayName: string, sequence: number): ChatMessage {
  return { messageId: `preview-message-${sequence}`, clientMessageId: `preview-client-${sequence}`, sequence: String(sequence), participantId, displayName, text, createdAt: PREVIEW_TIME, attachments: [] };
}
