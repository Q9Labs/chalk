import type { ControlEvent, ControlState, SyncClock, SyncSocket, SyncWebSocketFactory } from "../types";

export const participantSessionId = "participant-session-me";
export const stateSchemaVersion = 1;

export type TestEventFields = {
  readonly eventId: string;
  readonly name: ControlEvent["name"];
  readonly baseRevision: number;
  readonly revision: number;
  readonly payload: ControlEvent["payload"];
  readonly commandId?: string;
  readonly lifecycleIntentId?: string;
  readonly stateSchemaVersion?: number;
  readonly resultingStateDigest?: string;
};

export function event(fields: TestEventFields): ControlEvent & { readonly type: "event" } {
  return {
    ...fields,
    type: "event",
    stateSchemaVersion: fields.stateSchemaVersion ?? stateSchemaVersion,
    resultingStateDigest: fields.resultingStateDigest ?? "0".repeat(64),
  } as ControlEvent & { readonly type: "event" };
}

export function setHand(state: ControlState, handRaised: boolean): ControlState {
  return { ...state, participants: state.participants.map((participant) => ({ ...participant, handRaised })) };
}

export function ids(...values: string[]) {
  let index = 0;
  return { next: () => values[index++] ?? "command-00000099" };
}

export function sent(socket: TestSocket): unknown[] {
  return socket.sent.map((frame) => JSON.parse(frame));
}

export function isDeliveryAck(frame: unknown): frame is { readonly type: "delivery_ack"; readonly stream: "control"; readonly revision: number; readonly stateDigest: string } {
  return typeof frame === "object" && frame !== null && "type" in frame && frame.type === "delivery_ack";
}

export function isRecoveryAck(frame: unknown): frame is { readonly type: "recovery_ack"; readonly recoveryId: string; readonly revision: number; readonly stateDigest: string } {
  return typeof frame === "object" && frame !== null && "type" in frame && frame.type === "recovery_ack";
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
}

export class TestSockets implements SyncWebSocketFactory {
  readonly sockets: TestSocket[] = [];

  connect(_: string): SyncSocket {
    const socket = new TestSocket();
    this.sockets.push(socket);
    return socket;
  }

  latest(): TestSocket {
    const socket = this.sockets.at(-1);
    if (!socket) {
      throw new Error("missing test socket");
    }
    return socket;
  }
}

export class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  open(): void {
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

export class TestClock implements SyncClock {
  #now = 0;

  now(): number {
    return this.#now;
  }

  setTimeout(): unknown {
    return Symbol("timer");
  }

  clearTimeout(): void {}
}
