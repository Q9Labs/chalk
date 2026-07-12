import { describe, expect, it } from "vitest";
import { syncV2ProtocolCodec } from "./v2-codec";

const participantSessionId = "11111111-1111-4111-8111-111111111111";
const recoveryId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const commandId = "command-00000001";
const digest = "a".repeat(64);

describe("sync v2 generated codec", () => {
  it("strictly decodes snake_case frames and encodes semantic client frames", () => {
    const encoded = syncV2ProtocolCodec.encodeClient({
      type: "hello",
      protocol: 2,
      token: "test-token",
      streams: { control: { cursor: { revision: 2, stateSchemaVersion: 1, stateDigest: digest } } },
    });

    expect(JSON.parse(encoded)).toEqual({
      type: "hello",
      protocol: 2,
      token: "test-token",
      streams: { control: { cursor: { revision: 2, state_schema_version: 1, state_digest: digest } } },
    });
    expect(JSON.parse(syncV2ProtocolCodec.encodeClient({ type: "delivery_ack", stream: "control", revision: 3, stateDigest: digest }))).toEqual({
      type: "delivery_ack",
      stream: "control",
      revision: 3,
      state_digest: digest,
    });
    expect(JSON.parse(syncV2ProtocolCodec.encodeClient({ type: "recovery_ack", recoveryId, revision: 0, stateDigest: digest }))).toEqual({
      type: "recovery_ack",
      recovery_id: recoveryId,
      revision: 0,
      state_digest: digest,
    });
    expect(syncV2ProtocolCodec.decodeServer(JSON.stringify({ type: "retryable_error", command_id: commandId, code: "dependency_unavailable" }))).toEqual({
      type: "retryable_error",
      commandId,
      code: "dependency_unavailable",
    });
    expect(
      syncV2ProtocolCodec.decodeServer(
        JSON.stringify({
          type: "event",
          stream: "control",
          name: "hand_raised",
          event_id: eventId,
          base_revision: 2,
          revision: 3,
          schema_version: 1,
          resulting_state_digest: digest,
          payload: { participant_session_id: participantSessionId },
          command_id: commandId,
        }),
      ),
    ).toMatchObject({
      type: "event",
      name: "hand_raised",
      commandId,
      payload: { participantSessionId },
      stateSchemaVersion: 1,
    });
    expect(() => syncV2ProtocolCodec.decodeServer(JSON.stringify({ type: "pong", unexpected: true }))).toThrow();
  });

  it("maps terminal snapshot recovery state without exposing wire field names", () => {
    const frame = syncV2ProtocolCodec.decodeServer(
      JSON.stringify({
        type: "welcome",
        protocol: 2,
        participant_session_id: participantSessionId,
        participant_session_generation: 1,
        recovery_id: recoveryId,
        head: { revision: 0, state_schema_version: 1, state_digest: digest },
        mode: "snapshot",
        snapshot: {
          control_revision: 0,
          state_schema_version: 1,
          state_digest: digest,
          status: "active",
          participants: [],
        },
      }),
    );

    expect(frame).toEqual({
      type: "welcome",
      protocol: 2,
      participantSessionId,
      participantSessionGeneration: 1,
      recoveryId,
      mode: "snapshot",
      head: { revision: 0, stateSchemaVersion: 1, stateDigest: digest },
      snapshot: {
        revision: 0,
        stateSchemaVersion: 1,
        stateDigest: digest,
        state: { status: "active", participants: [] },
      },
    });
  });
});
