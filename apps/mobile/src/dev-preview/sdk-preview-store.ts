import type { ChalkProviderProps } from "@q9labsai/chalk-react-native";

import type { PreviewSearch, PreviewState } from "./preview-state";
import { PREVIEW_ADMISSION_REQUESTS, PREVIEW_CHAT_LINES, PREVIEW_DISPLAY_NAME } from "./sdk-preview-fixtures";

const SDK_FIELD = {
  spaceId: "roomId",
  episodeId: "sessionId",
  participantId: "participantSessionId",
  participantGeneration: "participantSessionGeneration",
  actions: "roomActions",
  participantActions: "participantRoomActionCapabilities",
} as const;

const PREVIEW_SUBJECT = {
  tenantId: "preview-tenant",
  [SDK_FIELD.spaceId]: "preview-space",
  [SDK_FIELD.episodeId]: "preview-episode",
  [SDK_FIELD.participantId]: "you",
  participantGeneration: 1,
} as const;

const PREVIEW_TIME = "2026-08-01T10:20:00.000Z";
const PREVIEW_EXPIRY = "2026-08-01T11:20:00.000Z";

const ALL_CAPABILITIES = ["publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand", "renameSelf", "manageAdmission", "promoteDemote", "transferHost", "muteOthers", "stopVideoOthers", "stopScreenOthers", "requestMediaOthers", "removeParticipant", "endMeeting"] as const;

const PARTICIPANT_FIXTURES = [
  { id: "you", displayName: PREVIEW_DISPLAY_NAME, role: "host" as const, handRaised: false, capabilities: ALL_CAPABILITIES },
  { id: "nora", displayName: "Nora Williams", role: "cohost" as const, handRaised: false, capabilities: ["publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand"] as const },
  { id: "akash", displayName: "Akash Jain", role: "participant" as const, handRaised: true, capabilities: ["publishAudio", "publishVideo", "subscribe", "raiseHand"] as const },
  { id: "sofia", displayName: "Sofia Chen", role: "participant" as const, handRaised: false, capabilities: ["publishAudio", "publishVideo", "subscribe", "raiseHand"] as const },
  { id: "malik", displayName: "Malik Brooks", role: "participant" as const, handRaised: false, capabilities: ["publishAudio", "publishVideo", "subscribe", "raiseHand"] as const },
] as const;

type SpaceStore = ChalkProviderProps["session"];
type SpaceSnapshot = ReturnType<SpaceStore["getSnapshot"]>;
type SpaceParticipant = SpaceSnapshot["participants"][number];
type SpaceMedia = SpaceSnapshot["localMedia"]["microphone"];
type SpaceMessage = SpaceSnapshot["chat"]["messages"][number];
type SpaceReaction = SpaceSnapshot["reactions"][number];
type SpaceFailure = NonNullable<SpaceSnapshot["failure"]>;
type SpaceLifecycle = Pick<SpaceSnapshot, "state" | "connection" | "failure">;
type SpacePage = Awaited<ReturnType<SpaceStore["loadOlderChatMessages"]>>;
type SpaceReceipt = NonNullable<Awaited<ReturnType<SpaceStore["markChatRead"]>>>;
type SpaceRequest = Awaited<ReturnType<SpaceStore["requestUnmute"]>>;
type SpaceWhiteboard = NonNullable<SpaceStore["whiteboard"]>;
type SpaceWhiteboardEvent = Parameters<SpaceWhiteboard["subscribe"]>[0] extends (event: infer Event) => unknown ? Event : never;
type SpaceWhiteboardElement = Parameters<SpaceWhiteboard["submitUpdate"]>[0]["elements"][number];
type SpaceWhiteboardCommit = Awaited<ReturnType<SpaceWhiteboard["submitUpdate"]>>;

const PREVIEW_REACTIONS: readonly SpaceReaction[] = [
  {
    eventId: "preview-reaction-1",
    [SDK_FIELD.participantId]: "nora",
    displayName: "Nora Williams",
    reaction: "🎉",
    occurredAt: "2026-08-01T10:15:00.000Z",
    expiresAt: "2026-08-01T10:16:00.000Z",
  },
];

const PREVIEW_MESSAGES: readonly SpaceMessage[] = PREVIEW_CHAT_LINES.map((line, index) => ({
  messageId: `preview-message-${index + 1}`,
  clientMessageId: `preview-client-${index + 1}`,
  sequence: String(index + 1),
  [SDK_FIELD.participantId]: line.displayName === PREVIEW_DISPLAY_NAME ? "you" : line.displayName === "Nora Williams" ? "nora" : "sofia",
  displayName: line.displayName,
  text: line.text,
  createdAt: `2026-08-01T10:${12 + index}:00.000Z`,
  attachments: [],
}));

type PreviewParticipant = SpaceParticipant;
type PreviewMedia = SpaceMedia;

export function createPreviewStore(search: PreviewSearch): SpaceStore {
  let snapshot = createPreviewSnapshot(search);
  const listeners = new Set<() => void>();

  const update = (next: SpaceSnapshot | ((current: SpaceSnapshot) => SpaceSnapshot)): void => {
    snapshot = typeof next === "function" ? next(snapshot) : next;
    for (const listener of [...listeners]) listener();
  };

  const updateParticipants = (project: (participant: PreviewParticipant) => PreviewParticipant): void => {
    update((current) => ({ ...current, participants: current.participants.map(project) }));
  };

  const setLocalMedia = (source: "microphone" | "camera" | "screen", state: PreviewMedia["state"]): void => {
    update((current) => ({
      ...current,
      localMedia: { ...current.localMedia, [source]: { ...current.localMedia[source], state } },
      participantMedia: {
        ...current.participantMedia,
        you: {
          ...(current.participantMedia.you ?? inactiveParticipantMedia()),
          ...(source === "microphone" ? { microphone: state === "enabled" ? "active" : "inactive" } : {}),
          ...(source === "camera" ? { camera: state === "enabled" ? "active" : "inactive" } : {}),
          ...(source === "screen" ? { screenShare: state === "enabled" ? "active" : "inactive" } : {}),
        },
      },
    }));
  };

  const store: SpaceStore = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    chatFiles: null,
    whiteboard: createPreviewWhiteboardTransport(),
    join: async () => update(createPreviewSnapshot({ ...search, state: "happy" })),
    leave: async () => update((current) => ({ ...current, state: "left", connection: { sync: "stopped", media: "stopped" } })),
    setMicrophoneEnabled: async (enabled) => setLocalMedia("microphone", enabled ? "enabled" : "disabled"),
    setCameraEnabled: async (enabled) => setLocalMedia("camera", enabled ? "enabled" : "disabled"),
    startScreenShare: async () => setLocalMedia("screen", "enabled"),
    stopScreenShare: async () => setLocalMedia("screen", "disabled"),
    setHandRaised: async (raised) => updateParticipants((participant) => (participant[SDK_FIELD.participantId] === "you" ? { ...participant, handRaised: raised } : participant)),
    setDisplayName: async (displayName) => updateParticipants((participant) => (participant[SDK_FIELD.participantId] === "you" ? { ...participant, displayName } : participant)),
    setAdmissionPolicy: async (policy) => update((current) => ({ ...current, admissionPolicy: policy })),
    setParticipantRole: async (participantId, role) => updateParticipants((participant) => (participant[SDK_FIELD.participantId] === participantId ? { ...participant, role } : participant)),
    transferHost: async (participantId) => updateParticipants((participant) => ({ ...participant, role: participant[SDK_FIELD.participantId] === participantId ? "host" : participant.role === "host" ? "cohost" : participant.role })),
    admitParticipant: async (admissionRequestId) => {
      update((current) => {
        const request = current.admissionRequests.find((candidate) => candidate.admissionRequestId === admissionRequestId);
        if (!request) return current;
        const participant: PreviewParticipant = {
          [SDK_FIELD.participantId]: request[SDK_FIELD.participantId],
          displayName: request.displayName,
          handRaised: false,
          role: request.initialRole,
          eligibleRoles: request.eligibleRoles,
          capabilities: ["publishAudio", "publishVideo", "subscribe", "raiseHand"],
        };
        return {
          ...current,
          admissionRequests: current.admissionRequests.filter((candidate) => candidate.admissionRequestId !== admissionRequestId),
          participants: [...current.participants, participant],
          participantMedia: { ...current.participantMedia, [participant[SDK_FIELD.participantId]]: inactiveParticipantMedia() },
        };
      });
    },
    denyAdmission: async (admissionRequestId) => update((current) => ({ ...current, admissionRequests: current.admissionRequests.filter((candidate) => candidate.admissionRequestId !== admissionRequestId) })),
    muteParticipant: async (participantId) => updateParticipantMedia(participantId, "microphone", "inactive"),
    stopParticipantCamera: async (participantId) => updateParticipantMedia(participantId, "camera", "inactive"),
    stopParticipantScreenShare: async (participantId) => updateParticipantMedia(participantId, "screenShare", "inactive"),
    removeParticipant: async (participantId) => update((current) => ({ ...current, participants: current.participants.filter((participant) => participant[SDK_FIELD.participantId] !== participantId) })),
    endSession: async () => update((current) => ({ ...current, state: "left", connection: { sync: "stopped", media: "stopped" } })),
    sendReaction: async (reaction) => {
      const next: SpaceReaction = { eventId: `preview-reaction-${snapshot.reactions.length + 1}`, [SDK_FIELD.participantId]: "you", displayName: PREVIEW_DISPLAY_NAME, reaction, occurredAt: PREVIEW_TIME, expiresAt: PREVIEW_EXPIRY };
      update((current) => ({ ...current, reactions: [...current.reactions, next] }));
      return next;
    },
    sendChatMessage: async (input) => {
      const next = createMessage(input.text, "you", PREVIEW_DISPLAY_NAME, snapshot.chat.messages.length + 1, input.clientMessageId);
      update((current) => ({ ...current, chat: { ...current.chat, status: "ready", messages: [...current.chat.messages, next], pending: current.chat.pending.filter((pending) => pending.clientMessageId !== next.clientMessageId) } }));
      return next;
    },
    retryChatMessage: async (clientMessageId) => {
      const pending = snapshot.chat.pending.find((candidate) => candidate.clientMessageId === clientMessageId);
      const next = createMessage(pending?.text ?? "Retrying message", "you", PREVIEW_DISPLAY_NAME, snapshot.chat.messages.length + 1, clientMessageId);
      update((current) => ({ ...current, chat: { ...current.chat, status: "ready", messages: [...current.chat.messages, next], pending: current.chat.pending.filter((candidate) => candidate.clientMessageId !== clientMessageId) } }));
      return next;
    },
    loadOlderChatMessages: async (): Promise<SpacePage> => {
      update((current) => ({ ...current, chat: { ...current.chat, status: "ready", hasOlder: false } }));
      return { status: "loaded", count: 0, hasOlder: false };
    },
    markChatRead: async (throughSequence): Promise<SpaceReceipt | null> => {
      const sequence = throughSequence ?? snapshot.chat.messages.at(-1)?.sequence;
      if (!sequence) return null;
      const receipt: SpaceReceipt = { [SDK_FIELD.participantId]: "you", [SDK_FIELD.participantGeneration]: 1, readThroughSequence: sequence, readAt: PREVIEW_TIME };
      update((current) => ({ ...current, chat: { ...current.chat, unreadCount: 0, localReadThroughSequence: sequence, readReceipts: [receipt] } }));
      return receipt;
    },
    requestUnmute: async (): Promise<SpaceRequest> => ({ status: "delivered", requestId: "preview-request-unmute" }),
    requestStartCamera: async (): Promise<SpaceRequest> => ({ status: "delivered", requestId: "preview-request-camera" }),
    acceptMediaRequest: async () => undefined,
    declineMediaRequest: () => undefined,
  };

  return store;

  function updateParticipantMedia(participantId: string, source: "microphone" | "camera" | "screenShare", state: "active" | "inactive"): void {
    update((current) => ({ ...current, participantMedia: { ...current.participantMedia, [participantId]: { ...(current.participantMedia[participantId] ?? inactiveParticipantMedia()), [source]: state } } }));
  }
}

export function createPreviewSnapshot(search: PreviewSearch): SpaceSnapshot {
  const lifecycle = lifecycleFor(search.state);
  const participants = participantsFor(search.participants, search);
  const localMedia = {
    microphone: localMediaFor("microphone", lifecycle, search.mic),
    camera: localMediaFor("camera", lifecycle, search.camera),
    screen: localMediaFor("screen", lifecycle, false),
  } satisfies SpaceSnapshot["localMedia"];

  return {
    state: lifecycle.state,
    subject: { ...PREVIEW_SUBJECT },
    connection: lifecycle.connection,
    admissionPolicy: "approval",
    participants,
    admissionRequests:
      lifecycle.state === "left" || search.state === "empty"
        ? []
        : PREVIEW_ADMISSION_REQUESTS.map((request) => ({ admissionRequestId: request.id, [SDK_FIELD.participantId]: request.id, displayName: request.displayName, initialRole: "participant", eligibleRoles: ["cohost", "participant"], expiresAt: PREVIEW_EXPIRY })),
    localMedia,
    remoteMedia: [],
    failure: lifecycle.failure,
    [SDK_FIELD.actions]: { phase: lifecycle.state === "failed" ? "failed" : lifecycle.state === "left" ? "stopped" : "healthy", version: 2, capabilities: ["sendChat", "sendReaction"], error: null },
    [SDK_FIELD.participantActions]: Object.fromEntries(participants.map((participant) => [participant[SDK_FIELD.participantId], ["sendChat", "sendReaction"]])) as SpaceSnapshot[typeof SDK_FIELD.participantActions],
    participantMedia: Object.fromEntries(participants.map((participant) => [participant[SDK_FIELD.participantId], participantMediaFor(participant, search)])) as SpaceSnapshot["participantMedia"],
    reactions: PREVIEW_REACTIONS,
    chat: chatFor(search),
    whiteboard: whiteboardSummary(),
    incomingMediaRequests: [],
  };
}

function lifecycleFor(state: PreviewState): SpaceLifecycle {
  switch (state) {
    case "reconnecting":
      return { state: "reconnecting", connection: { sync: "recovering", media: "recovering" }, failure: null };
    case "retry":
      return { state: "live", connection: { sync: "failed", media: "healthy" }, failure: failureFor("sync_recovery_exhausted", "The Space connection needs another try.") };
    case "warning":
      return { state: "live", connection: { sync: "healthy", media: "failed" }, failure: failureFor("media_recovery_exhausted", "Some Space media needs another try.") };
    case "timeout":
      return { state: "failed", connection: { sync: "failed", media: "failed" }, failure: failureFor("sync_recovery_exhausted", "The Space took too long to reconnect.") };
    case "failure":
      return { state: "failed", connection: { sync: "failed", media: "failed" }, failure: failureFor("sync_start_failed", "The Space connection failed before recovery completed.") };
    case "ended":
      return { state: "left", connection: { sync: "stopped", media: "stopped" }, failure: failureFor("session_ended", "This Episode has ended.", false) };
    default:
      return { state: "live", connection: { sync: "healthy", media: "healthy" }, failure: null };
  }
}

function failureFor(code: SpaceFailure["code"], message: string, recoverable = true): SpaceFailure {
  return { code, action: null, recoverable, message };
}

function participantsFor(count: PreviewSearch["participants"], search: PreviewSearch): readonly PreviewParticipant[] {
  return PARTICIPANT_FIXTURES.slice(0, count).map((fixture, index) => ({
    [SDK_FIELD.participantId]: fixture.id,
    displayName: fixture.displayName,
    handRaised: index === 0 ? search.hand : fixture.handRaised,
    role: fixture.role,
    eligibleRoles: fixture.role === "host" ? ["host", "cohost", "participant"] : ["cohost", "participant"],
    capabilities: [...fixture.capabilities],
  }));
}

function localMediaFor(source: "microphone" | "camera" | "screen", lifecycle: ReturnType<typeof lifecycleFor>, intended: boolean): PreviewMedia {
  const state = lifecycle.state === "failed" ? (intended ? "failed" : "unavailable") : lifecycle.state === "live" || lifecycle.state === "reconnecting" ? (intended ? "enabled" : "disabled") : "unavailable";
  return { source, state, track: null };
}

function participantMediaFor(participant: PreviewParticipant, search: PreviewSearch): SpaceSnapshot["participantMedia"][string] {
  if (participant[SDK_FIELD.participantId] === "you") return { microphone: search.mic ? "active" : "inactive", camera: search.camera ? "active" : "inactive", screenShare: "inactive" };
  const fixture = PARTICIPANT_FIXTURES.find((candidate) => candidate.id === participant[SDK_FIELD.participantId]);
  return { microphone: fixture && fixture.id !== "akash" ? "active" : "inactive", camera: fixture && fixture.id !== "akash" ? "active" : "inactive", screenShare: "inactive" };
}

function inactiveParticipantMedia(): SpaceSnapshot["participantMedia"][string] {
  return { microphone: "inactive", camera: "inactive", screenShare: "inactive" };
}

function chatFor(search: PreviewSearch): SpaceSnapshot["chat"] {
  const pending =
    search.chat === "pending"
      ? [{ clientMessageId: "preview-pending-1", text: "I’m sending the latest Space notes…", attachments: [], state: "sending" as const, error: null }]
      : search.chat === "failure"
        ? [{ clientMessageId: "preview-failed-1", text: "Could not publish this update", attachments: [], state: "failed" as const, error: failureFor("internal_error", "Chat is temporarily unavailable.") }]
        : [];
  return {
    status: search.chat === "loading" ? "loading" : search.chat === "failure" ? "failed" : "ready",
    messages: search.chat === "empty" || search.chat === "loading" || search.chat === "failure" ? [] : PREVIEW_MESSAGES,
    pending,
    hasOlder: search.chat === "loading",
    historyTruncated: false,
    retainedFloorSequence: null,
    unreadCount: search.chat === "ready" || search.chat === "pending" ? 2 : 0,
    readReceipts: [],
    localReadThroughSequence: null,
    error: search.chat === "failure" ? failureFor("internal_error", "Chat is temporarily unavailable.") : null,
  };
}

function whiteboardSummary(): SpaceSnapshot["whiteboard"] {
  return { status: "ready", sceneId: "preview-board", revision: "1", capabilities: ["drawWhiteboard", "manageWhiteboard"], canDraw: true, canClear: true, error: null };
}

function createPreviewWhiteboardTransport(): SpaceWhiteboard {
  const listeners = new Set<(event: SpaceWhiteboardEvent) => void>();
  let elements: readonly SpaceWhiteboardElement[] = [];
  let revision = 1;
  const emitSnapshot = (): void => {
    const event: SpaceWhiteboardEvent = { type: "snapshot", sceneId: "preview-board", revision: String(revision), elements };
    for (const listener of [...listeners]) listener(event);
  };
  const commit = (nextElements: readonly SpaceWhiteboardElement[]): SpaceWhiteboardCommit => {
    elements = nextElements;
    revision += 1;
    const result = { operationId: `preview-whiteboard-${revision}`, sceneId: "preview-board", revision: String(revision) };
    const event: SpaceWhiteboardEvent = { type: "update", sceneId: result.sceneId, revision: result.revision, elements };
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

function createMessage(text: string, participantId: string, displayName: string, sequence: number, clientMessageId?: string): SpaceMessage {
  return { messageId: `preview-message-${sequence}`, clientMessageId: clientMessageId ?? `preview-client-${sequence}`, sequence: String(sequence), [SDK_FIELD.participantId]: participantId, displayName, text, createdAt: PREVIEW_TIME, attachments: [] };
}
