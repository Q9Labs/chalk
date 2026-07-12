import { Schema } from "effect";
import { ClientFrameSchema as GeneratedClientFrameSchema, ServerFrameSchema as GeneratedServerFrameSchema, encodeSyncFrame, type EventFrame as GeneratedEventFrame, type ServerFrame as GeneratedServerFrame, type Snapshot as GeneratedSnapshot } from "../generated/sync-v2";
import type { SyncProtocolCodec } from "./protocol";
import type { ClientFrame, ControlEvent, ServerFrame, SnapshotRecovery, SyncHead, WelcomeFrame } from "./types";

export const syncV2ProtocolCodec: SyncProtocolCodec = {
  encodeClient(frame) {
    const generated = Schema.decodeUnknownSync(GeneratedClientFrameSchema)(toGeneratedClientFrame(frame));
    return encodeSyncFrame(generated);
  },
  decodeServer(wire) {
    const generated = Schema.decodeUnknownSync(GeneratedServerFrameSchema)(JSON.parse(wire));
    return fromGeneratedServerFrame(generated);
  },
};

type ClientFrameEncoders = {
  readonly [Type in ClientFrame["type"]]: (frame: Extract<ClientFrame, { readonly type: Type }>) => unknown;
};

const clientFrameEncoders = {
  hello: toGeneratedHello,
  command: toGeneratedCommand,
  delivery_ack: toGeneratedDeliveryAck,
  recovery_ack: toGeneratedRecoveryAck,
  ping: toGeneratedPing,
} satisfies ClientFrameEncoders;

function toGeneratedClientFrame(frame: ClientFrame): unknown {
  return clientFrameEncoders[frame.type](frame as never);
}

function toGeneratedHello(frame: Extract<ClientFrame, { readonly type: "hello" }>): unknown {
  return {
    type: "hello",
    protocol: frame.protocol,
    token: frame.token,
    streams: {
      control: {
        cursor: frame.streams.control.cursor === null ? null : toGeneratedHead(frame.streams.control.cursor),
      },
    },
  };
}

function toGeneratedCommand(frame: Extract<ClientFrame, { readonly type: "command" }>): unknown {
  return { type: "command", command_id: frame.commandId, name: frame.name, payload: frame.payload ?? {} };
}

function toGeneratedDeliveryAck(frame: Extract<ClientFrame, { readonly type: "delivery_ack" }>): unknown {
  return { type: "delivery_ack", stream: frame.stream, revision: frame.revision, state_digest: frame.stateDigest };
}

function toGeneratedRecoveryAck(frame: Extract<ClientFrame, { readonly type: "recovery_ack" }>): unknown {
  return { type: "recovery_ack", recovery_id: frame.recoveryId, revision: frame.revision, state_digest: frame.stateDigest };
}

function toGeneratedPing(_: Extract<ClientFrame, { readonly type: "ping" }>): unknown {
  return { type: "ping" };
}

type ServerFrameDecoders = {
  readonly [Type in GeneratedServerFrame["type"]]: (frame: Extract<GeneratedServerFrame, { readonly type: Type }>) => ServerFrame;
};

const serverFrameDecoders = {
  welcome: fromGeneratedWelcome,
  replay_page: fromGeneratedReplayPage,
  recovery_complete: fromGeneratedRecoveryComplete,
  event: fromGeneratedEventFrame,
  ack: fromGeneratedAck,
  retryable_error: fromGeneratedRetryableError,
  error: fromGeneratedError,
  pong: fromGeneratedPong,
} satisfies ServerFrameDecoders;

function fromGeneratedServerFrame(frame: GeneratedServerFrame): ServerFrame {
  return serverFrameDecoders[frame.type](frame as never);
}

function fromGeneratedReplayPage(frame: Extract<GeneratedServerFrame, { readonly type: "replay_page" }>): ServerFrame {
  return {
    type: "replay_page",
    recoveryId: frame.recovery_id,
    firstRevision: frame.first_revision,
    lastRevision: frame.last_revision,
    events: frame.events.map(fromGeneratedEvent),
  };
}

function fromGeneratedRecoveryComplete(frame: Extract<GeneratedServerFrame, { readonly type: "recovery_complete" }>): ServerFrame {
  return { type: "recovery_complete", recoveryId: frame.recovery_id, head: fromGeneratedHead(frame.head) };
}

function fromGeneratedEventFrame(frame: Extract<GeneratedServerFrame, { readonly type: "event" }>): ServerFrame {
  return { type: "event", ...fromGeneratedEvent(frame) };
}

function fromGeneratedAck(frame: Extract<GeneratedServerFrame, { readonly type: "ack" }>): ServerFrame {
  if (frame.result === "rejected") {
    return { type: "ack", commandId: frame.command_id, result: "rejected", reason: frame.reason };
  }
  return { type: "ack", commandId: frame.command_id, result: frame.result, eventId: frame.event_id, revision: frame.revision };
}

function fromGeneratedRetryableError(frame: Extract<GeneratedServerFrame, { readonly type: "retryable_error" }>): ServerFrame {
  return { type: "retryable_error", commandId: frame.command_id, code: frame.code };
}

function fromGeneratedError(frame: Extract<GeneratedServerFrame, { readonly type: "error" }>): ServerFrame {
  return { type: "error", code: frame.code };
}

function fromGeneratedPong(_: Extract<GeneratedServerFrame, { readonly type: "pong" }>): ServerFrame {
  return { type: "pong" };
}

type GeneratedWelcome = Extract<GeneratedServerFrame, { readonly type: "welcome" }>;

type WelcomeModeDecoders = {
  readonly [Mode in GeneratedWelcome["mode"]]: (frame: Extract<GeneratedWelcome, { readonly mode: Mode }>) => WelcomeFrame;
};

const welcomeModeDecoders = {
  snapshot: fromGeneratedSnapshotWelcome,
  replay: fromGeneratedReplayWelcome,
  up_to_date: fromGeneratedUpToDateWelcome,
  terminal: fromGeneratedTerminalWelcome,
} satisfies WelcomeModeDecoders;

function fromGeneratedWelcome(frame: GeneratedWelcome): WelcomeFrame {
  return welcomeModeDecoders[frame.mode](frame as never);
}

function fromGeneratedWelcomeBase(frame: GeneratedWelcome) {
  return {
    type: "welcome" as const,
    protocol: frame.protocol,
    participantSessionId: frame.participant_session_id,
    participantSessionGeneration: frame.participant_session_generation,
    recoveryId: frame.recovery_id,
    head: fromGeneratedHead(frame.head),
  };
}

function fromGeneratedSnapshotWelcome(frame: Extract<GeneratedWelcome, { readonly mode: "snapshot" }>): WelcomeFrame {
  return { ...fromGeneratedWelcomeBase(frame), mode: "snapshot", snapshot: fromGeneratedSnapshot(frame.snapshot) };
}

function fromGeneratedReplayWelcome(frame: Extract<GeneratedWelcome, { readonly mode: "replay" }>): WelcomeFrame {
  return { ...fromGeneratedWelcomeBase(frame), mode: "replay" };
}

function fromGeneratedUpToDateWelcome(frame: Extract<GeneratedWelcome, { readonly mode: "up_to_date" }>): WelcomeFrame {
  return { ...fromGeneratedWelcomeBase(frame), mode: "up_to_date" };
}

function fromGeneratedTerminalWelcome(frame: Extract<GeneratedWelcome, { readonly mode: "terminal" }>): WelcomeFrame {
  return { ...fromGeneratedWelcomeBase(frame), mode: "terminal", terminalReason: frame.reason };
}

function fromGeneratedSnapshot(snapshot: GeneratedSnapshot): SnapshotRecovery {
  return {
    revision: snapshot.control_revision,
    stateSchemaVersion: snapshot.state_schema_version,
    stateDigest: snapshot.state_digest,
    state: {
      status: snapshot.status,
      participants: snapshot.participants.map((participant) => ({
        participantSessionId: participant.participant_session_id,
        displayName: participant.display_name,
        handRaised: participant.hand_raised,
      })),
    },
  };
}

type GeneratedEventDecoders = {
  readonly [Name in GeneratedEventFrame["name"]]: (frame: Extract<GeneratedEventFrame, { readonly name: Name }>) => ControlEvent;
};

const generatedEventDecoders = {
  participant_joined: fromGeneratedParticipantJoined,
  participant_left: fromGeneratedParticipantLeft,
  session_ended: fromGeneratedSessionEnded,
  hand_raised: fromGeneratedHandEvent,
  hand_lowered: fromGeneratedHandEvent,
} satisfies GeneratedEventDecoders;

function fromGeneratedEvent(frame: GeneratedEventFrame): ControlEvent {
  return generatedEventDecoders[frame.name](frame as never);
}

function fromGeneratedEventBase(frame: GeneratedEventFrame) {
  return {
    eventId: frame.event_id,
    baseRevision: frame.base_revision,
    revision: frame.revision,
    stateSchemaVersion: frame.schema_version,
    resultingStateDigest: frame.resulting_state_digest,
  };
}

function fromGeneratedParticipantJoined(frame: Extract<GeneratedEventFrame, { readonly name: "participant_joined" }>): ControlEvent {
  return {
    ...fromGeneratedEventBase(frame),
    name: frame.name,
    lifecycleIntentId: frame.lifecycle_intent_id,
    payload: { participantSessionId: frame.payload.participant_session_id, displayName: frame.payload.display_name },
  };
}

function fromGeneratedParticipantLeft(frame: Extract<GeneratedEventFrame, { readonly name: "participant_left" }>): ControlEvent {
  return {
    ...fromGeneratedEventBase(frame),
    name: frame.name,
    lifecycleIntentId: frame.lifecycle_intent_id,
    payload: { participantSessionId: frame.payload.participant_session_id },
  };
}

function fromGeneratedSessionEnded(frame: Extract<GeneratedEventFrame, { readonly name: "session_ended" }>): ControlEvent {
  return { ...fromGeneratedEventBase(frame), name: frame.name, lifecycleIntentId: frame.lifecycle_intent_id, payload: {} };
}

function fromGeneratedHandEvent(frame: Extract<GeneratedEventFrame, { readonly name: "hand_raised" | "hand_lowered" }>): ControlEvent {
  return {
    ...fromGeneratedEventBase(frame),
    name: frame.name,
    commandId: frame.command_id,
    payload: { participantSessionId: frame.payload.participant_session_id },
  };
}

function fromGeneratedHead(head: { readonly revision: number; readonly state_schema_version: number; readonly state_digest: string }): SyncHead {
  return { revision: head.revision, stateSchemaVersion: head.state_schema_version, stateDigest: head.state_digest };
}

function toGeneratedHead(head: SyncHead): { readonly revision: number; readonly state_schema_version: number; readonly state_digest: string } {
  return { revision: head.revision, state_schema_version: head.stateSchemaVersion, state_digest: head.stateDigest };
}
