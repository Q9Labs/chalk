import type { ChalkSessionDiagnosticsSnapshot, ParticipantState, RoomState, Transcript, UIState } from "./core";
import { ChalkErrorClass } from "./core";
import { ObservableManager } from "./observable-manager";
import type { RealtimeKitMeeting } from "./realtimekit-ports";
import { projectParticipant } from "./realtimekit-ports";

const emptyRoomState: RoomState = {
  id: null,
  status: "disconnected",
  error: null,
  roomId: null,
  roomName: null,
  isJoining: false,
  hostId: null,
};

export interface ConnectedRoom extends RoomState {
  readonly transcripts: readonly Transcript[];
  on(event: "transcript", handler: (transcript: Transcript) => void): (() => void) | void;
  off(event: "transcript", handler: (transcript: Transcript) => void): void;
}

export class RoomManager extends ObservableManager<RoomState> {
  #connectedRoom: ConnectedRoom | null = null;

  constructor() {
    super(emptyRoomState);
  }

  getRoom = (): ConnectedRoom | null => this.#connectedRoom;

  connecting(roomId: string, roomName: string | null = null): void {
    this.#connectedRoom = null;
    this.replaceState({ ...emptyRoomState, id: roomId, roomId, roomName, status: "connecting", isJoining: true });
  }

  connected(roomId: string, meeting: RealtimeKitMeeting): void {
    const state: RoomState = {
      ...this.getState(),
      id: roomId,
      roomId,
      roomName: meeting.meta?.meetingTitle ?? this.getState().roomName,
      status: "connected",
      isJoining: false,
      error: null,
      hostId: meeting.self.isHost ? meeting.self.id : this.getState().hostId,
      rtkMeeting: meeting,
    };
    this.#connectedRoom = {
      ...state,
      transcripts: [],
      on: () => undefined,
      off: () => undefined,
    };
    this.replaceState(state);
  }

  reconnecting(): void {
    this.patchState({ status: "reconnecting", isJoining: false, error: null });
  }

  disconnected(roomId = this.getState().roomId ?? ""): void {
    this.#connectedRoom = null;
    this.replaceState({ ...emptyRoomState, id: roomId || null, roomId: roomId || null });
  }

  failed(roomId: string, error: string): void {
    this.#connectedRoom = null;
    this.patchState({ id: roomId || null, roomId: roomId || null, status: "failed", isJoining: false, error });
  }
}

export class ParticipantsManager extends ObservableManager<ParticipantState> {
  remoteParticipants: ParticipantState["participants"] = [];
  #meeting: RealtimeKitMeeting | null = null;
  #activeSpeakerId: string | null = null;
  #localRole: "host" | "participant" | null = null;

  constructor() {
    super({ participants: [], localParticipant: null, activeSpeaker: null, count: 0 });
  }

  getParticipant = (id: string) => this.getState().participants.find((participant) => participant.id === id);

  sync(meeting: RealtimeKitMeeting): void {
    this.#meeting = meeting;
    const localParticipant = projectParticipant(meeting.self, this.#localRole ?? undefined);
    this.remoteParticipants = meeting.participants.joined.toArray().map((participant) => projectParticipant(participant));
    const participants = [localParticipant, ...this.remoteParticipants];
    this.replaceState({
      participants,
      localParticipant,
      activeSpeaker: this.#activeSpeakerId ? (participants.find((participant) => participant.id === this.#activeSpeakerId) ?? null) : null,
      count: participants.length,
    });
  }

  setActiveSpeaker(meeting: RealtimeKitMeeting, value: unknown): void {
    this.#activeSpeakerId = readParticipantId(value);
    this.sync(meeting);
  }

  setLocalRole(role: unknown): void {
    this.#localRole = role === "host" ? "host" : "participant";
  }

  reset(): void {
    this.#meeting = null;
    this.#activeSpeakerId = null;
    this.#localRole = null;
    this.remoteParticipants = [];
    this.replaceState({ participants: [], localParticipant: null, activeSpeaker: null, count: 0 });
  }

  updateDisplayName = async (name: string): Promise<void> => {
    if (!this.#meeting) throw new ChalkErrorClass("The native meeting is not connected");
    this.#meeting.self.setName(name);
    this.sync(this.#meeting);
  };
}

export class UIManager extends ObservableManager<UIState> {
  #hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super({ layout: "grid", activePanel: null, controlsVisible: true, isMobileView: true, isFullscreen: false });
  }

  setLayout = (layout: UIState["layout"]): void => this.patchState({ layout });
  toggleLayout = (): void => this.patchState({ layout: this.getState().layout === "grid" ? "speaker" : "grid" });
  toggleFullscreen = async (): Promise<void> => this.patchState({ isFullscreen: !this.getState().isFullscreen });
  openPanel = (activePanel: UIState["activePanel"]): void => this.patchState({ activePanel });
  closePanel = (): void => this.patchState({ activePanel: null });
  togglePanel = (panel: Exclude<UIState["activePanel"], null>): void => this.patchState({ activePanel: this.getState().activePanel === panel ? null : panel });
  hideControls = (): void => this.patchState({ controlsVisible: false });
  showControls = (autoHideDelay?: number): void => {
    if (this.#hideTimer) clearTimeout(this.#hideTimer);
    this.patchState({ controlsVisible: true });
    if (autoHideDelay) this.#hideTimer = setTimeout(this.hideControls, autoHideDelay);
  };
}

function readParticipantId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { id?: unknown; peerId?: unknown };
  if (typeof candidate.id === "string") return candidate.id;
  return typeof candidate.peerId === "string" ? candidate.peerId : null;
}

export function connectionState(status: RoomState["status"]): ChalkSessionDiagnosticsSnapshot["websocketConnectionState"] {
  if (status === "connected") return "connected";
  if (status === "connecting") return "connecting";
  if (status === "reconnecting") return "reconnecting";
  if (status === "failed") return "failed";
  return "disconnected";
}
