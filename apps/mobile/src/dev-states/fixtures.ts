import { SpaceClientError, type Capability, type Participant, type SpaceSnapshot } from "@q9labsai/chalk-client";
import { createPreviewClient, createSnapshot } from "./preview-client";
import type { ScenarioCode } from "./codes";
import { createFixtureEvents } from "./events";
import { boardTransport } from "./whiteboard";

const names = ["Hasan", "Nora Patel", "Akash Rao", "Sofia Lind", "Malik Haddad", "Priya Shah"];
const guestCapabilities = ["publishAudio", "publishVideo", "publishScreen", "subscribe", "sendChat", "sendReaction", "raiseHand", "renameSelf", "drawWhiteboard"] as const;
const hostCapabilities = [...guestCapabilities, "manageAdmission", "assignRoles", "muteOthers", "stopVideoOthers", "stopScreenOthers", "requestMediaOthers", "removeParticipant", "manageRecording", "endEpisode"] as const satisfies readonly Capability[];
const at = "2026-10-18T10:00:00.000Z";

export function snapshotForCodes(codes: readonly ScenarioCode[]): SpaceSnapshot {
  const has = (code: ScenarioCode) => codes.includes(code);
  const count = has("P4") ? 24 : has("P3") ? 6 : has("P2") ? 2 : 1;
  const base = createSnapshot(has("U2") ? hostCapabilities : has("K8") ? guestCapabilities.filter((capability) => capability !== "drawWhiteboard") : guestCapabilities);
  const roster: Participant[] = Array.from({ length: count }, (_, index) => ({
    participantId: `person-${index}`,
    displayName: names[index % names.length] ?? `Person ${index + 1}`,
    role: index === 0 && has("U2") ? "host" : "guest",
    eligibleRoles: ["guest", "host"],
    capabilities: index === 0 ? base.self.capabilities : guestCapabilities,
    handRaised: false,
    media: { microphone: has("K1") ? "inactive" : "active", camera: has("K2") ? "inactive" : "active", screenShare: has("C2") && index === (has("W2") ? 0 : 1) ? "active" : "inactive" },
    presence: { state: "connected", speaking: index === 1, activeSpeaker: index === 1 },
  }));
  const status = has("T1") ? "joining" : has("T5") ? "reconnecting" : has("A5") ? "failed" : codes.some((code) => ["A3", "A4", "A6"].includes(code)) ? "left" : "live";
  return {
    ...base,
    connection: { status, episode: { id: "fixture-episode", startedAt: at, deadline: null }, lastError: has("A5") ? { code: "connection.sync_start_failed", message: "Could not join the call", recoverable: true } : null },
    self: { ...base.self, participantId: "person-0", displayName: has("K7") ? null : "Hasan", role: has("U2") ? "host" : "guest" },
    participants: { roster, admissionQueue: has("F2") ? [{ requestId: "knock-1", participantId: "visitor", displayName: "Rania Aziz", initialRole: "guest", eligibleRoles: ["guest"], expiresAt: "2099-01-01T00:00:00.000Z" }] : [] },
    chat: {
      ...base.chat,
      status: "ready",
      unreadCount: has("F4") ? 1 : 0,
      messages: [
        {
          messageId: "m1",
          clientMessageId: "c1",
          sequence: "1",
          participantId: "person-1",
          displayName: "Nora Patel",
          text: "Morning! I put the plan in the board.",
          createdAt: at,
          attachments: has("F14") ? [{ attachmentId: "photo-1", fileName: "plan.jpg", mimeType: "image/jpeg", byteLength: 1024 }] : [],
        },
      ],
    },
    recording: { current: has("K5") ? { recordingId: "recording-1", status: "recording", failureCode: null } : null },
    whiteboard: { open: has("C3"), engine: { status: has("C3") ? "ready" : "unsubscribed", sceneId: has("C3") ? "board-1" : null, revision: "1", presenting: has("C3"), error: null } },
  };
}

// A device that refuses a turn-on rejects the call, which is how the SDK learns to show its permission and busy toasts.
function refuseTurnOn(codes: readonly ScenarioCode[], device: "microphone" | "camera"): SpaceClientError | null {
  if (device === "microphone" && codes.includes("K1")) return new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Microphone access is denied" });
  if (device === "camera" && codes.includes("K2")) return new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Camera access is denied" });
  if (device === "camera" && codes.includes("F1")) return new SpaceClientError({ code: "media.device_busy", recoverable: true, message: "Another app is using your camera" });
  return null;
}

function guardTurnOn<T>(codes: readonly ScenarioCode[], device: "microphone" | "camera", turnOn: (enabled: boolean) => Promise<T>): (enabled: boolean) => Promise<T> {
  return (enabled: boolean) => {
    const refusal = enabled ? refuseTurnOn(codes, device) : null;
    return refusal ? Promise.reject(refusal) : turnOn(enabled);
  };
}

export function createFixtureClient(codes: readonly ScenarioCode[]) {
  const client = createPreviewClient(snapshotForCodes(codes));
  const dispose = client.dispose;
  const events = createFixtureEvents();
  const transport = boardTransport((presenting) => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, open: presenting, engine: { ...current.whiteboard.engine, presenting } } })));
  return Object.assign(client, {
    on: events.on,
    emit: events.emit,
    media: {
      ...client.media,
      setMicrophoneEnabled: guardTurnOn(codes, "microphone", client.media.setMicrophoneEnabled),
      setCameraEnabled: guardTurnOn(codes, "camera", client.media.setCameraEnabled),
    },
    fire(code: ScenarioCode): string {
      const snapshot = client.getSnapshot();
      const self = snapshot.participants.roster[0];
      if (!self) throw new Error("Fixture roster has no self participant");
      switch (code) {
        case "F1":
          events.emit("error", { error: new SpaceClientError({ code: "media.device_busy", recoverable: true, message: "Another app is using your camera" }) });
          return "Another app is using your camera";
        case "F2":
          client.updateSnapshot((current) => ({ ...current, participants: { ...current.participants, admissionQueue: [{ requestId: "knock-1", participantId: "visitor", displayName: "Rania Aziz", initialRole: "guest", eligibleRoles: ["guest"], expiresAt: "2099-01-01T00:00:00.000Z" }] } }));
          return "Rania Aziz wants to join";
        case "F3":
          client.updateSnapshot((current) => ({ ...current, media: { ...current.media, incomingRequests: [{ requestId: "unmute-1", kind: "unmute", actorParticipantId: "person-1", actorDisplayName: "Nora Patel", expiresAt: "2099-01-01T00:00:00.000Z" }] } }));
          return "Nora asks you to unmute";
        case "F4":
          client.updateSnapshot((current) => ({
            ...current,
            chat: {
              ...current.chat,
              unreadCount: current.chat.unreadCount + 1,
              messages: [...current.chat.messages, { messageId: "new-message", clientMessageId: "new-client-message", sequence: "2", participantId: "person-1", displayName: "Nora Patel", text: "Can everyone see my screen?", createdAt: at, attachments: [] }],
            },
          }));
          return "New message";
        case "F5": {
          const participant = { ...self, participantId: "visitor", displayName: "Rania Aziz", role: "guest" };
          client.updateSnapshot((current) => ({ ...current, participants: { ...current.participants, roster: [...current.participants.roster, participant] } }));
          events.emit("participantJoined", { participant });
          return "Rania Aziz joined";
        }
        case "F6": {
          const participant = snapshot.participants.roster.findLast((person) => person.participantId !== self.participantId);
          if (!participant) throw new Error("F6 needs at least two people");
          client.updateSnapshot((current) => ({ ...current, participants: { ...current.participants, roster: current.participants.roster.filter((person) => person.participantId !== participant.participantId) } }));
          events.emit("participantLeft", { participant });
          return `${participant.displayName} left`;
        }
        case "F7":
          client.updateSnapshot((current) => ({ ...current, media: { ...current.media, selection: { ...current.media.selection, speaker: "preview-speaker" } } }));
          return "AirPods disconnected. Switched to speaker";
        case "F8":
        case "F9":
          client.updateSnapshot((current) => ({ ...current, media: { ...current.media, local: { ...current.media.local, microphone: { ...current.media.local.microphone, state: "disabled" } } } }));
          return code === "F8" ? "Nora muted you" : "You're muted";
        case "F10":
          client.updateSnapshot((current) => ({
            ...current,
            self: { ...current.self, role: "host", capabilities: hostCapabilities, can: (capability) => hostCapabilities.some((value) => value === capability) },
            participants: { ...current.participants, roster: current.participants.roster.filter((person) => person.participantId !== "person-1").map((person) => (person.participantId === self.participantId ? { ...person, role: "host" } : person)) },
          }));
          return "Nora left. You're now the host";
        case "F11":
          client.updateSnapshot((current) => ({
            ...current,
            media: { ...current.media, remote: current.media.remote.filter((media) => media.source !== "screen") },
            participants: { ...current.participants, roster: current.participants.roster.map((person) => ({ ...person, media: { ...person.media, screenShare: "inactive" } })) },
          }));
          events.emit("screenShareStopped", { participantId: "person-1" });
          return "Nora stopped sharing";
        case "F12":
          client.updateSnapshot((current) => ({ ...current, reactions: { active: [{ eventId: "fixture-reaction", participantId: "person-1", displayName: "Nora Patel", reaction: "🎉", occurredAt: at, expiresAt: "2099-01-01T00:00:00.000Z" }] } }));
          return "Nora reacted";
        case "F13":
          throw new Error("F13 needs message-reaction SDK support; the public client has no reaction field on ChatMessage");
        case "F14":
          client.updateSnapshot((current) => ({ ...current, chat: { ...current.chat, messages: current.chat.messages.map((message) => ({ ...message, attachments: [{ attachmentId: "photo-1", fileName: "plan.jpg", mimeType: "image/jpeg", byteLength: 1024 }] })) } }));
          return "Photos in chat";
        case "F15":
          client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live" } }));
          return "Your phone call ended. You're back in the call";
        default:
          throw new Error(`Not a mockup fire code: ${code}`);
      }
    },
    whiteboard: { transport: () => transport },
    dispose: () => {
      dispose();
      events.clear();
    },
  });
}
