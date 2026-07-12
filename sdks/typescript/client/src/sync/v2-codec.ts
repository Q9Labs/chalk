import { Schema } from "effect";
import { ClientFrameSchema as GeneratedClientFrameSchema, ServerFrameSchema as GeneratedServerFrameSchema, encodeSyncFrame, type EventFrame as GeneratedEventFrame, type ServerFrame as GeneratedServerFrame, type Snapshot as GeneratedSnapshot } from "../generated/sync-v2";
import type { SyncProtocolCodec } from "./protocol";
import type { ClientFrame, ControlEvent, ServerFrame, SnapshotRecovery, SyncHead, WelcomeFrame } from "./types";

type GeneratedWelcome = Extract<GeneratedServerFrame, { readonly type: "welcome" }>;
type GeneratedHead = GeneratedWelcome["head"];

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

function toGeneratedClientFrame(frame: ClientFrame): unknown {
  switch (frame.type) {
    case "hello":
      return {
        type: "hello",
        protocol: frame.protocol,
        token: frame.token,
        streams: {
          control: {
            cursor:
              frame.streams.control.cursor === null
                ? null
                : {
                    revision: frame.streams.control.cursor.revision,
                    state_schema_version: frame.streams.control.cursor.stateSchemaVersion,
                    state_digest: frame.streams.control.cursor.stateDigest,
                  },
          },
        },
      };
    case "command":
      return { type: "command", command_id: frame.commandId, name: frame.name, payload: frame.payload ?? {} };
    case "delivery_ack":
      return { type: "delivery_ack", stream: frame.stream, revision: frame.revision, state_digest: frame.stateDigest };
    case "recovery_ack":
      return { type: "recovery_ack", recovery_id: frame.recoveryId, revision: frame.revision, state_digest: frame.stateDigest };
    case "ping":
      return { type: "ping" };
  }
}

function fromGeneratedServerFrame(frame: GeneratedServerFrame): ServerFrame {
  switch (frame.type) {
    case "welcome":
      return fromGeneratedWelcome(frame);
    case "replay_page":
      return {
        type: "replay_page",
        recoveryId: frame.recovery_id,
        firstRevision: frame.first_revision,
        lastRevision: frame.last_revision,
        events: frame.events.map(fromGeneratedEvent),
      };
    case "recovery_complete":
      return { type: "recovery_complete", recoveryId: frame.recovery_id, head: fromGeneratedHead(frame.head) };
    case "event":
      return { type: "event", ...fromGeneratedEvent(frame) };
    case "ack":
      if (frame.result === "rejected") {
        return { type: "ack", commandId: frame.command_id, result: "rejected", reason: frame.reason };
      }
      return { type: "ack", commandId: frame.command_id, result: frame.result, eventId: frame.event_id, revision: frame.revision };
    case "retryable_error":
      return { type: "retryable_error", commandId: frame.command_id, code: frame.code };
    case "error":
      return { type: "error", code: frame.code };
    case "pong":
      return { type: "pong" };
  }
}

function fromGeneratedWelcome(frame: GeneratedWelcome): WelcomeFrame {
  const welcome = {
    type: "welcome" as const,
    protocol: frame.protocol,
    participantSessionId: frame.participant_session_id,
    participantSessionGeneration: frame.participant_session_generation,
    recoveryId: frame.recovery_id,
    head: fromGeneratedHead(frame.head),
  };

  switch (frame.mode) {
    case "snapshot":
      return { ...welcome, mode: "snapshot", snapshot: fromGeneratedSnapshot(frame.snapshot) };
    case "replay":
      return { ...welcome, mode: "replay" };
    case "up_to_date":
      return { ...welcome, mode: "up_to_date" };
    case "terminal":
      return { ...welcome, mode: "terminal", terminalReason: frame.reason };
  }
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

function fromGeneratedEvent(frame: GeneratedEventFrame): ControlEvent {
  const event = {
    eventId: frame.event_id,
    baseRevision: frame.base_revision,
    revision: frame.revision,
    stateSchemaVersion: frame.schema_version,
    resultingStateDigest: frame.resulting_state_digest,
  };

  switch (frame.name) {
    case "participant_joined":
      return {
        ...event,
        name: frame.name,
        lifecycleIntentId: frame.lifecycle_intent_id,
        payload: { participantSessionId: frame.payload.participant_session_id, displayName: frame.payload.display_name },
      };
    case "participant_left":
      return {
        ...event,
        name: frame.name,
        lifecycleIntentId: frame.lifecycle_intent_id,
        payload: { participantSessionId: frame.payload.participant_session_id },
      };
    case "session_ended":
      return { ...event, name: frame.name, lifecycleIntentId: frame.lifecycle_intent_id, payload: {} };
    case "hand_raised":
    case "hand_lowered":
      return {
        ...event,
        name: frame.name,
        commandId: frame.command_id,
        payload: { participantSessionId: frame.payload.participant_session_id },
      };
  }
}

function fromGeneratedHead(head: GeneratedHead): SyncHead {
  return { revision: head.revision, stateSchemaVersion: head.state_schema_version, stateDigest: head.state_digest };
}
