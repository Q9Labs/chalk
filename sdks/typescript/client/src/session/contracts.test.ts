import { describe, expect, expectTypeOf, it } from "vitest";
import * as effectSurface from "../effect";
import * as rootSurface from "../index";
import {
  CHALK_SESSION_ACTIONS,
  CHALK_SESSION_ERROR_CODES,
  CHALK_SESSION_STATES,
  ParticipantAccessError,
  isParticipantAccess,
  parseParticipantAccess,
  requireParticipantAccess,
  type ChalkSessionActionName,
  type ChalkSessionActions,
  type ChalkChatFileTransport,
  type ChalkSessionErrorCode,
  type ChalkSessionSnapshot,
  type ChalkSessionStore,
  type ChalkWhiteboardV1Transport,
  type ParticipantAccess,
  type ParticipantMediaCredential,
  type ParticipantSyncCredential,
} from ".";

describe("ParticipantAccess", () => {
  it("accepts distinct Sync and media credentials", () => {
    const access = validAccess();

    expect(parseParticipantAccess(access)).toEqual(access);
    expect(isParticipantAccess(access)).toBe(true);
  });

  it("rejects credentials with crossed audiences", () => {
    const access = validAccess();

    expect(() => parseParticipantAccess({ ...access, sync: { ...access.sync, token: access.media.token } })).toThrow(ParticipantAccessError);
    expect(() => parseParticipantAccess({ ...access, media: { ...access.media, token: access.sync.token } })).toThrow(ParticipantAccessError);
  });

  it("rejects a Sync-shaped media object", () => {
    const access = validAccess();

    expect(() => parseParticipantAccess({ ...access, media: access.sync })).toThrow(ParticipantAccessError);
    expect(isParticipantAccess({ ...access, media: access.sync })).toBe(false);
  });

  it("validates successful HTTP responses", async () => {
    await expect(requireParticipantAccess(Response.json(validAccess()))).resolves.toEqual(validAccess());
    await expect(requireParticipantAccess(Response.json({}, { status: 401 }))).rejects.toBeInstanceOf(ParticipantAccessError);
    await expect(requireParticipantAccess(new Response("not json"))).rejects.toBeInstanceOf(ParticipantAccessError);
  });

  it("keeps credential types non-interchangeable", () => {
    expectTypeOf<ParticipantSyncCredential>().not.toEqualTypeOf<ParticipantMediaCredential>();
    expectTypeOf<ParticipantAccess["sync"]>().not.toEqualTypeOf<ParticipantAccess["media"]>();
  });
});

describe("public session contract", () => {
  it("keeps generated Effect contracts on the Effect entry point", () => {
    expectTypeOf<"ChalkApi" extends keyof typeof rootSurface ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<"TenantIdSchema" extends keyof typeof rootSurface ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<"createChalkEffectClient" extends keyof typeof rootSurface ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<"ChalkApi" extends keyof typeof effectSurface ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<"TenantIdSchema" extends keyof typeof effectSurface ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<"createChalkEffectClient" extends keyof typeof effectSurface ? true : false>().toEqualTypeOf<true>();
    expect(rootSurface).not.toHaveProperty("ChalkApi");
    expect(rootSurface).not.toHaveProperty("TenantIdSchema");
    expect(rootSurface).not.toHaveProperty("createChalkEffectClient");
    expect(effectSurface).toHaveProperty("ChalkApi");
    expect(effectSurface).toHaveProperty("TenantIdSchema");
    expect(effectSurface).toHaveProperty("createChalkEffectClient");
  });

  it("freezes states, errors, and actions without recording", () => {
    expect(CHALK_SESSION_STATES).toEqual(["idle", "joining", "live", "reconnecting", "leaving", "left", "failed"]);
    expect(CHALK_SESSION_ACTIONS).toEqual([
      "join",
      "leave",
      "setMicrophoneEnabled",
      "setCameraEnabled",
      "startScreenShare",
      "stopScreenShare",
      "setHandRaised",
      "setDisplayName",
      "setAdmissionPolicy",
      "setParticipantRole",
      "transferHost",
      "admitParticipant",
      "denyAdmission",
      "muteParticipant",
      "stopParticipantCamera",
      "stopParticipantScreenShare",
      "removeParticipant",
      "endSession",
      "sendReaction",
      "sendChatMessage",
      "retryChatMessage",
      "loadOlderChatMessages",
      "markChatRead",
      "requestUnmute",
      "requestStartCamera",
      "acceptMediaRequest",
      "declineMediaRequest",
    ]);
    expect(CHALK_SESSION_ACTIONS).not.toContain("startRecording");
    expect(CHALK_SESSION_ACTIONS).not.toContain("stopRecording");
    expect(CHALK_SESSION_ERROR_CODES).toEqual([
      "invalid_state",
      "invalid_access",
      "access_unavailable",
      "permission_denied",
      "sync_start_failed",
      "media_start_failed",
      "join_cleanup_unconfirmed",
      "sync_recovery_exhausted",
      "media_recovery_exhausted",
      "command_rejected",
      "leave_unconfirmed",
      "session_ended",
      "unsupported_environment",
      "internal_error",
      "room_actions_unavailable",
      "chat_cursor_reset_required",
      "rate_limited",
      "invalid_payload",
    ]);
    expectTypeOf<"recording" extends keyof ChalkSessionSnapshot ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<"startRecording" extends ChalkSessionActionName ? true : false>().toEqualTypeOf<false>();
  });

  it("freezes room-action snapshot, action, and store seams", () => {
    assertRoomActionTypes();
  });
});

function assertRoomActionTypes(): void {
  expectTypeOf<ChalkSessionSnapshot["roomActions"]>().toEqualTypeOf<{
    readonly phase: "disabled" | "negotiating" | "healthy" | "recovering" | "failed" | "stopped";
    readonly version: 1 | 2 | null;
    readonly capabilities: readonly ("sendReaction" | "sendChat")[];
    readonly error: {
      readonly code: ChalkSessionErrorCode;
      readonly action: ChalkSessionActionName | null;
      readonly recoverable: boolean;
      readonly message: string;
    } | null;
  }>();
  expectTypeOf<ChalkSessionSnapshot["chat"]["messages"][number]["sequence"]>().toEqualTypeOf<string>();
  expectTypeOf<ChalkSessionSnapshot["chat"]["pending"][number]["state"]>().toEqualTypeOf<"sending" | "failed">();
  expectTypeOf<ChalkSessionSnapshot["incomingMediaRequests"][number]["kind"]>().toEqualTypeOf<"unmute" | "start_camera">();
  expectTypeOf<Parameters<ChalkSessionActions["sendReaction"]>[0]>().toEqualTypeOf<"👍" | "❤️" | "😂" | "😮" | "😢" | "🎉">();
  expectTypeOf<Awaited<ReturnType<ChalkSessionActions["loadOlderChatMessages"]>>["status"]>().toEqualTypeOf<"loaded" | "cursor_reset">();
  expectTypeOf<Awaited<ReturnType<ChalkSessionActions["markChatRead"]>>>().toEqualTypeOf<{
    readonly participantSessionId: string;
    readonly participantSessionGeneration: number;
    readonly readThroughSequence: string;
    readonly readAt: string;
  } | null>();
  expectTypeOf<Awaited<ReturnType<ChalkSessionActions["requestUnmute"]>>["status"]>().toEqualTypeOf<"delivered" | "target_unavailable" | "expired" | "rejected" | "rate_limited">();
  expectTypeOf<ChalkSessionStore["whiteboard"]>().toEqualTypeOf<ChalkWhiteboardV1Transport | null>();
  expectTypeOf<ChalkSessionStore["chatFiles"]>().toEqualTypeOf<ChalkChatFileTransport | null>();
}

function validAccess() {
  return {
    subject: {
      tenantId: "tenant-1",
      roomId: "room-1",
      sessionId: "session-1",
      participantSessionId: "participant-1",
      participantGeneration: 1,
    },
    sync: { token: token("chalk-sync"), expiresAt: "2026-07-21T12:00:00.000Z" },
    media: {
      token: token("chalk-media"),
      expiresAt: "2026-07-21T12:00:00.000Z",
      provider: "cloudflare_sfu",
      clientPayload: { connectionId: "connection-1", stunServer: "stun:stun.cloudflare.com:3478" },
    },
  } as const;
}

function token(audience: "chalk-sync" | "chalk-media"): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ aud: audience })}.signature`;
}
