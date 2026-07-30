import type { ChatMessage, ChatState, InteractionState, RecordingState, WhiteboardSnapshot, WhiteboardState, WhiteboardUpdate } from "./core";
import { ChalkErrorClass } from "./core";

export const unavailable = (capability: string): ChalkErrorClass => new ChalkErrorClass(`${capability} is unavailable in this native runtime`);
const noSubscriptions =
  <State>() =>
  (_listener: (state: State) => void): (() => void) =>
  () =>
    undefined;

export function unavailableInteractionManager() {
  const state: InteractionState = { handRaised: false, isHandRaised: false, raisedHandCount: 0, raisedHands: [], activeReactions: [] };
  const reject = (): never => {
    throw unavailable("Hand raise without a canonical session store");
  };
  return { getState: () => state, subscribe: noSubscriptions<InteractionState>(), raiseHand: reject, lowerHand: reject, toggleHand: reject };
}

export function unavailableChatManager() {
  const state: ChatState = { messages: [] as ChatMessage[], unreadCount: 0, isEnabled: false, count: 0 };
  return { getState: () => state, subscribe: noSubscriptions<ChatState>() };
}

export function unavailableRecordingManager() {
  const state: RecordingState = { isRecording: false, isStarting: false, isStopping: false, recordingId: null, startedAt: null };
  return {
    getState: () => state,
    subscribe: noSubscriptions<RecordingState>(),
    start: () => Promise.reject(unavailable("Native recording")),
    stop: () => Promise.reject(unavailable("Native recording")),
    on: (_event: string, _handler: (...args: unknown[]) => void) => undefined,
    off: (_event: string, _handler: (...args: unknown[]) => void) => undefined,
  };
}

export function unavailableWhiteboardManager() {
  const state: WhiteboardState = { isOpen: false, cursors: [], openParticipants: [], canDraw: false, elements: [], elementCount: 0, lastSeq: 0 };
  return {
    getState: () => state,
    subscribe: noSubscriptions<WhiteboardState>(),
    on: (_event: "snapshot" | "update", _handler: (value: WhiteboardSnapshot | WhiteboardUpdate) => void) => undefined,
    off: (_event: "snapshot" | "update", _handler: (value: WhiteboardSnapshot | WhiteboardUpdate) => void) => undefined,
    open: () => undefined,
    close: () => undefined,
    sendUpdate: (_elements: unknown[], _files?: Record<string, unknown>, _seq?: number) => undefined,
    sendCursor: (_x: number, _y: number) => undefined,
    requestSync: () => undefined,
    clear: () => undefined,
    grantPermission: (_participantId: string) => undefined,
    revokePermission: (_participantId: string) => undefined,
  };
}
