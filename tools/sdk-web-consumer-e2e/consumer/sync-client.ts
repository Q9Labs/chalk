// Fallow cannot see that ChalkSession consumes this adapter through the ChalkSessionSyncClient interface.
// fallow-ignore-file unused-class-member
import type { ChalkSessionSyncClient, V3AssignableRole, V3CommandResult, V3MediaSource, V3SelfMediaTargetResult, V3SessionSnapshot } from "@q9labsai/chalk-client";
import type { ChalkSessionMediaClient, ChalkSessionSyncFactoryInput } from "@q9labsai/chalk-client";

import { initialSyncSnapshot, syncSnapshot, type ServerMessage } from "./protocol";
import { registerSocket } from "./resource-ledger";

export class FixtureSyncClient implements ChalkSessionSyncClient {
  readonly #access: ChalkSessionSyncFactoryInput["access"];
  readonly #listeners = new Set<(snapshot: V3SessionSnapshot) => void>();
  readonly #media: ChalkSessionMediaClient;
  readonly #syncURL: string;
  readonly #token: () => Promise<string>;
  #pending = new Map<string, { resolve: (value: V3CommandResult) => void; reject: (error: Error) => void }>();
  #snapshot: V3SessionSnapshot;
  #socket: WebSocket | null = null;

  constructor(syncURL: string, input: ChalkSessionSyncFactoryInput) {
    this.#syncURL = syncURL;
    this.#access = input.access;
    this.#token = input.token;
    this.#media = input.media;
    this.#snapshot = initialSyncSnapshot(input.access.subject.participantSessionId, input.access.subject.participantGeneration);
  }

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: (snapshot: V3SessionSnapshot) => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async start(): Promise<void> {
    const token = await this.#token();
    this.#publish({ ...this.#snapshot, connection: { phase: "connecting" } });
    await new Promise<void>((resolve, reject) => {
      const socket = registerSocket(new WebSocket(`${this.#syncURL}?token=${encodeURIComponent(token)}`));
      this.#socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new TypeError("Fixture Sync socket failed")), { once: true });
      socket.addEventListener("message", (event) => this.#onMessage(JSON.parse(String(event.data)) as ServerMessage));
      socket.addEventListener("close", () => {
        if (this.#socket !== socket) return;
        this.#socket = null;
        for (const pending of this.#pending.values()) pending.reject(new TypeError("Fixture Sync socket closed"));
        this.#pending.clear();
        if (this.#snapshot.connection.phase !== "stopped") this.#publish({ ...this.#snapshot, connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
      });
    });
  }

  stop = (): void => {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.#publish({ ...this.#snapshot, connection: { phase: "stopped" } });
  };

  leave = () => this.#command("participant_leave", {});
  setHandRaised = (raised: boolean) => this.#command("set_hand_raised", { raised });
  setDisplayName = (displayName: string) => this.#command("set_display_name", { displayName });
  setAdmissionPolicy = (policy: string) => this.#command("set_admission_policy", { policy });
  setParticipantRole = (participantSessionId: string, role: V3AssignableRole) => this.#command("set_participant_role", { participantSessionId, role });
  transferHost = (participantSessionId: string) => this.#command("transfer_host", { participantSessionId });
  admit = (admissionRequestId: string) => this.#command("admit_participant", { admissionRequestId });
  deny = (admissionRequestId: string) => this.#command("deny_admission", { admissionRequestId });
  muteParticipant = (participantSessionId: string) => this.#command("mute_participant", { participantSessionId });
  stopParticipantCamera = (participantSessionId: string) => this.#command("stop_participant_camera", { participantSessionId });
  stopParticipantScreenShare = (participantSessionId: string) => this.#command("stop_participant_screen_share", { participantSessionId });
  removeParticipant = (participantSessionId: string) => this.#command("remove_participant", { participantSessionId });
  endSession = () => this.#command("end_session", {});

  setMicrophoneEnabled = (enabled: boolean) => this.#setMedia("microphone", enabled, "set_microphone_enabled");
  setCameraEnabled = (enabled: boolean) => this.#setMedia("camera", enabled, "set_camera_enabled");
  setScreenShareEnabled = (enabled: boolean) => this.#setMedia("screen", enabled, "set_screen_share_enabled");

  async #setMedia(source: V3MediaSource, enabled: boolean, name: V3SelfMediaTargetResult["name"]): Promise<V3SelfMediaTargetResult> {
    const operationId = crypto.randomUUID();
    const mediaResult = await this.#media.setLocalPublicationTarget({ operationId, participantSessionId: this.#access.subject.participantSessionId, source, enabled });
    if (mediaResult.outcome !== "confirmed" && mediaResult.outcome !== "satisfied") throw new TypeError(`Fixture media rejected ${source}`);
    await this.#command(name, { source, enabled });
    return { operationId, name, serverOutcome: "confirmed", mediaPlaneOutcome: mediaResult.outcome };
  }

  #command(name: string, payload: Record<string, unknown>): Promise<V3CommandResult> {
    const id = crypto.randomUUID();
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new TypeError("Fixture Sync is not connected"));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "command", id, name, payload }));
    });
  }

  #onMessage(message: ServerMessage): void {
    if (message.type === "state") {
      this.#publish(syncSnapshot(this.#snapshot, message.state));
      return;
    }
    if (message.type !== "ack") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    pending.resolve({ type: "ack", command_id: message.id, delivery: "original", outcome: "satisfied", revision: 1, state_digest: "fixture" } as V3CommandResult);
  }

  #publish(snapshot: V3SessionSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
