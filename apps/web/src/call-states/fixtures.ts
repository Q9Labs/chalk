import type { Capability, ChalkWhiteboardV1Event, ChalkWhiteboardV1Transport, ChatMessage, ClientEventHandler, ClientEventMap, ClientEventName, Participant, RemoteMedia, SpaceSnapshot } from "@q9labsai/chalk-client";
import { createPreviewClient, createSnapshot } from "@q9labsai/chalk-react/preview";
import { cameraTrack, screenTrack } from "./media";

export type Person = {
  readonly id: string;
  readonly name: string;
  readonly camera?: boolean;
  readonly microphone?: boolean;
  readonly speaking?: boolean;
  readonly handRaised?: boolean;
  readonly sharing?: boolean;
};

const BACKGROUNDS = ["#4d5d73", "#5c6650", "#6b5b4f", "#64576b", "#49645d", "#665d42", "#315f72", "#6d5158"];

export const SELF_ID = "you";
export const SELF_NAME = "Hasan";
export const SPACE_NAME = "Q9 team";
export const INVITE_LINK = "https://chalkmeet.com/space/q9-team#spaceInviteToken=example";

export const PEOPLE: readonly Person[] = [
  { id: "nora", name: "Nora Patel" },
  { id: "akash", name: "Akash Rao" },
  { id: "sofia", name: "Sofia Lind" },
  { id: "malik", name: "Malik Haddad" },
  { id: "priya", name: "Priya Shah" },
  { id: "eli", name: "Eli Cohen" },
  { id: "june", name: "June Park" },
  { id: "tomas", name: "Tomás Ruiz" },
  { id: "lena", name: "Lena Vogel" },
  { id: "kenji", name: "Kenji Mori" },
  { id: "amara", name: "Amara Okafor" },
  { id: "omar", name: "Omar Siddiqui" },
];

export const GUEST: readonly Capability[] = ["publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand", "renameSelf", "sendChat", "sendReaction", "drawWhiteboard", "manageWhiteboard"];
export const HOST: readonly Capability[] = [...GUEST, "manageAdmission", "assignRoles", "muteOthers", "stopVideoOthers", "stopScreenOthers", "requestMediaOthers", "removeParticipant", "manageRecording", "endEpisode"];

export type LiveOptions = {
  readonly self?: Omit<Person, "id" | "name">;
  readonly others?: readonly Person[];
  readonly capabilities?: readonly Capability[];
  readonly status?: SpaceSnapshot["connection"]["status"];
  readonly board?: boolean;
  readonly recording?: boolean;
  readonly chat?: readonly ChatMessage[];
  readonly admission?: boolean;
  readonly lastError?: SpaceSnapshot["connection"]["lastError"];
  readonly offlinePending?: boolean;
  readonly mediaRequest?: boolean;
  readonly reactions?: boolean;
};

const startedAt = new Date(Date.now() - (25 * 60 + 9) * 1000).toISOString();

export function liveSnapshot(options: LiveOptions = {}): SpaceSnapshot {
  const capabilities = options.capabilities ?? GUEST;
  const base = createSnapshot(capabilities);
  const self = { camera: true, microphone: true, ...options.self };
  const others = options.others ?? [];
  const now = Date.now();
  const roster: Participant[] = [participant({ id: SELF_ID, name: SELF_NAME, ...self }, capabilities), ...others.map((person) => participant(person, GUEST))];
  const remote: RemoteMedia[] = others.flatMap((person, index) => [
    ...(person.camera === false ? [] : [{ participantId: person.id, source: "camera" as const, publicationId: `${person.id}-camera`, track: cameraTrack(person.name, BACKGROUNDS[index % BACKGROUNDS.length]!) }]),
    ...(person.sharing ? [{ participantId: person.id, source: "screen" as const, publicationId: `${person.id}-screen`, track: screenTrack() }] : []),
  ]);
  return {
    ...base,
    connection: { status: options.status ?? "live", episode: { id: "ep_01JC9Q9TEAM", startedAt, deadline: null }, lastError: options.lastError ?? null },
    self: { ...base.self, participantId: SELF_ID, displayName: SELF_NAME, role: capabilities === HOST ? "host" : "guest", handRaised: self.handRaised ?? false },
    participants: {
      roster,
      admissionQueue: options.admission ? [{ requestId: "req-1", participantId: "guest-1", displayName: "Rania Aziz", initialRole: "guest", eligibleRoles: ["guest"], expiresAt: new Date(now + 60_000).toISOString() }] : [],
    },
    media: {
      ...base.media,
      local: {
        microphone: { source: "microphone", state: self.microphone ? "enabled" : "disabled", track: null },
        camera: { source: "camera", state: self.camera ? "enabled" : "disabled", track: self.camera ? cameraTrack(SELF_NAME, "#5d6b78") : null },
        screen: { source: "screen", state: self.sharing ? "enabled" : "disabled", track: self.sharing ? screenTrack() : null },
      },
      remote,
      incomingRequests: options.mediaRequest ? [{ requestId: "media-1", kind: "unmute", actorParticipantId: "nora", actorDisplayName: "Nora Patel", expiresAt: new Date(now + 60_000).toISOString() }] : [],
    },
    chat: options.chat ? { ...base.chat, status: "ready", messages: options.chat } : { ...base.chat, status: "ready" },
    reactions: options.reactions ? { active: [{ eventId: "r1", participantId: "nora", displayName: "Nora Patel", reaction: "🎉", occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }] } : base.reactions,
    recording: { current: options.recording ? { recordingId: "rec-1", status: "recording", failureCode: null } : null },
    offline: options.offlinePending
      ? {
          pending: [
            { id: "o1", kind: "chat_message", text: "Can everyone see my screen?", queuedAt: now - 12_000 },
            { id: "o2", kind: "hand_raise", text: null, queuedAt: now - 9_000 },
          ],
          decisionNeeded: true,
          policy: "ask",
        }
      : base.offline,
    whiteboard: { open: Boolean(options.board), engine: { status: options.board ? "ready" : "unsubscribed", sceneId: options.board ? "scene-1" : null, revision: options.board ? "1" : null, presenting: Boolean(options.board), error: null } },
  };
}

function participant(person: Person, capabilities: readonly Capability[]): Participant {
  return {
    participantId: person.id,
    displayName: person.name,
    role: "guest",
    eligibleRoles: ["guest", "host"],
    capabilities,
    handRaised: person.handRaised ?? false,
    media: { microphone: person.microphone === false ? "inactive" : "active", camera: person.camera === false ? "inactive" : "active", screenShare: person.sharing ? "active" : "inactive" },
    presence: { state: "connected", speaking: person.speaking ?? false, activeSpeaker: person.speaking ?? false },
  };
}

export function chatMessages(): ChatMessage[] {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return [
    { messageId: "m1", clientMessageId: "c1", sequence: "1", participantId: "nora", displayName: "Nora Patel", text: "Morning! I put the plan in the board.", createdAt: at(6), attachments: [] },
    { messageId: "m2", clientMessageId: "c2", sequence: "2", participantId: SELF_ID, displayName: SELF_NAME, text: "hello brothers", createdAt: at(4), attachments: [] },
    {
      messageId: "m3",
      clientMessageId: "c3",
      sequence: "3",
      participantId: "akash",
      displayName: "Akash Rao",
      text: "Here is the logo lockup we talked about.",
      createdAt: at(2),
      attachments: [{ attachmentId: "a1", fileName: "q9labs-logo-lockup-white-on-black.jpg", mimeType: "image/jpeg", byteLength: 482_113 }],
    },
  ];
}

export type CallStateClient = ReturnType<typeof createCallStateClient>;

/** The preview client plus the two seams Chalk needs from a live client: lifecycle events and a whiteboard transport. */
export function createCallStateClient(snapshot: SpaceSnapshot) {
  const client = createPreviewClient(snapshot);
  const handlers = new Map<ClientEventName, Set<(event: never) => void>>();
  const on = <TEvent extends ClientEventName>(event: TEvent, handler: ClientEventHandler<TEvent>) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler as (event: never) => void);
    handlers.set(event, set);
    return () => void set.delete(handler as (event: never) => void);
  };
  const emit = <TEvent extends ClientEventName>(event: TEvent, payload: ClientEventMap[TEvent]) => {
    for (const handler of handlers.get(event) ?? []) (handler as (event: ClientEventMap[TEvent]) => void)(payload);
  };
  const transport = boardTransport((presenting) => client.updateSnapshot((current) => ({ ...current, whiteboard: { open: presenting, engine: { ...current.whiteboard.engine, status: "ready", sceneId: "scene-1", revision: "1", presenting } } })));
  return Object.assign(client, { on, emit, whiteboard: { transport: () => transport } });
}

function boardTransport(present: (presenting: boolean) => void): ChalkWhiteboardV1Transport {
  const listeners = new Set<(event: ChalkWhiteboardV1Event) => void>();
  let revision = 1;
  const snapshot = (): ChalkWhiteboardV1Event => ({ type: "snapshot", sceneId: "scene-1", revision: String(revision), elements: [] });
  const commit = () => ({ operationId: `op-${++revision}`, sceneId: "scene-1", revision: String(revision) });
  return {
    startSceneSubscription: () => Promise.resolve(),
    stopSceneSubscription: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      queueMicrotask(() => listener(snapshot()));
      return () => void listeners.delete(listener);
    },
    submitUpdate: async () => commit(),
    sendCursor: () => undefined,
    requestSnapshot: async () => {
      for (const listener of listeners) listener(snapshot());
    },
    clear: async () => commit(),
    setDrawPermission: async () => undefined,
    setPresentation: async (presenting) => present(presenting),
    files: {
      initiateUpload: async () => ({ uploadId: "u1", method: "PUT", uploadUrl: "about:blank", headers: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      finalizeUpload: async () => undefined,
      getDownloadUrl: async () => ({ downloadUrl: "about:blank", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    },
  };
}
