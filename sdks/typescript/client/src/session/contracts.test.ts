import { describe, expect, expectTypeOf, it } from "vitest";
import * as effectSurface from "../effect";
import * as rootSurface from "../index";
import {
  CONNECTION_ACTIONS,
  CONNECTION_ERROR_CODES,
  CONNECTION_STATES,
  AccessGrantError,
  isParsedAccessGrant,
  parseParsedAccessGrant,
  requireParsedAccessGrant,
  type ConnectionActionName,
  type ConnectionActions,
  type ChalkChatFileTransport,
  type ConnectionErrorCode,
  type ConnectionSnapshot,
  type ConnectionStore,
  type ChalkWhiteboardV1Transport,
  type ParsedAccessGrant,
  type ParticipantMediaCredential,
  type ParticipantSyncCredential,
} from ".";

describe("ParsedAccessGrant", () => {
  it("accepts distinct Sync and media credentials", () => {
    const access = validAccess();
    const parsed = parseParsedAccessGrant(access);

    expect(parsed.subject).toEqual({ tenantId: "tenant-1", spaceId: "room-1", episodeId: "session-1", participantId: "participant-1", participantGeneration: 1 });
    expect(isParsedAccessGrant(access)).toBe(true);
  });

  it("rejects credentials with crossed audiences", () => {
    const access = validAccess();

    expect(() => parseParsedAccessGrant({ ...access, sync: { ...access.sync, token: access.media.token } })).toThrow(AccessGrantError);
    expect(() => parseParsedAccessGrant({ ...access, media: { ...access.media, token: access.sync.token } })).toThrow(AccessGrantError);
  });

  it("rejects a Sync-shaped media object", () => {
    const access = validAccess();

    expect(() => parseParsedAccessGrant({ ...access, media: access.sync })).toThrow(AccessGrantError);
    expect(isParsedAccessGrant({ ...access, media: access.sync })).toBe(false);
  });

  it("validates successful HTTP responses", async () => {
    await expect(requireParsedAccessGrant(Response.json(validAccess()))).resolves.toEqual(parseParsedAccessGrant(validAccess()));
    await expect(requireParsedAccessGrant(Response.json({}, { status: 401 }))).rejects.toBeInstanceOf(AccessGrantError);
    await expect(requireParsedAccessGrant(new Response("not json"))).rejects.toBeInstanceOf(AccessGrantError);
  });

  it("keeps credential types non-interchangeable", () => {
    expectTypeOf<ParticipantSyncCredential>().not.toEqualTypeOf<ParticipantMediaCredential>();
    expectTypeOf<ParsedAccessGrant["sync"]>().not.toEqualTypeOf<ParsedAccessGrant["media"]>();
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
    expect(CONNECTION_STATES).toEqual(["idle", "joining", "live", "reconnecting", "leaving", "left", "failed"]);
    expect(CONNECTION_ACTIONS).toEqual([
      "join",
      "leave",
      "setMicrophoneEnabled",
      "setCameraEnabled",
      "startScreenShare",
      "stopScreenShare",
      "setHandRaised",
      "setDisplayName",
      "setAdmissionPolicy",
      "assignRole",
      "admitParticipant",
      "denyAdmission",
      "muteParticipant",
      "stopParticipantCamera",
      "stopParticipantScreenShare",
      "removeParticipant",
      "endEpisode",
      "extendEpisode",
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
    expect(CONNECTION_ACTIONS).not.toContain("startRecording");
    expect(CONNECTION_ACTIONS).not.toContain("stopRecording");
    expect(CONNECTION_ERROR_CODES).toEqual([
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
      "collaboration_unavailable",
      "chat_cursor_reset_required",
      "rate_limited",
      "invalid_payload",
    ]);
    expectTypeOf<"recording" extends keyof ConnectionSnapshot ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<"startRecording" extends ConnectionActionName ? true : false>().toEqualTypeOf<false>();
  });

  it("freezes collaboration snapshot, action, and store seams", () => {
    assertCollaborationTypes();
  });
});

function assertCollaborationTypes(): void {
  expectTypeOf<ConnectionSnapshot["collaboration"]>().toEqualTypeOf<{
    readonly phase: "disabled" | "negotiating" | "healthy" | "recovering" | "failed" | "stopped";
    readonly version: 1 | null;
    readonly capabilities: readonly ("sendReaction" | "sendChat")[];
    readonly error: {
      readonly code: ConnectionErrorCode;
      readonly action: ConnectionActionName | null;
      readonly recoverable: boolean;
      readonly message: string;
    } | null;
  }>();
  expectTypeOf<ConnectionSnapshot["chat"]["messages"][number]["sequence"]>().toEqualTypeOf<string>();
  expectTypeOf<ConnectionSnapshot["chat"]["pending"][number]["state"]>().toEqualTypeOf<"sending" | "failed">();
  expectTypeOf<ConnectionSnapshot["incomingMediaRequests"][number]["kind"]>().toEqualTypeOf<"unmute" | "start_camera">();
  expectTypeOf<Parameters<ConnectionActions["sendReaction"]>[0]>().toEqualTypeOf<"👍" | "❤️" | "😂" | "😮" | "😢" | "🎉">();
  expectTypeOf<Awaited<ReturnType<ConnectionActions["loadOlderChatMessages"]>>["status"]>().toEqualTypeOf<"loaded" | "cursor_reset">();
  expectTypeOf<Awaited<ReturnType<ConnectionActions["markChatRead"]>>>().toEqualTypeOf<{
    readonly participantId: string;
    readonly participantGeneration: number;
    readonly readThroughSequence: string;
    readonly readAt: string;
  } | null>();
  expectTypeOf<Awaited<ReturnType<ConnectionActions["requestUnmute"]>>["status"]>().toEqualTypeOf<"delivered" | "target_unavailable" | "expired" | "rejected" | "rate_limited">();
  expectTypeOf<ConnectionStore["whiteboard"]>().toEqualTypeOf<ChalkWhiteboardV1Transport | null>();
  expectTypeOf<ConnectionStore["chatFiles"]>().toEqualTypeOf<ChalkChatFileTransport | null>();
}

function validAccess() {
  return {
    subject: {
      tenant_id: "tenant-1",
      space_id: "room-1",
      episode_id: "session-1",
      participant_id: "participant-1",
      participant_generation: 1,
    },
    sync: { token: token("chalk-sync"), expires_at: "2026-07-21T12:00:00.000Z" },
    media: {
      token: token("chalk-media"),
      expires_at: "2026-07-21T12:00:00.000Z",
      provider: "cloudflare_sfu",
      client_payload: { connectionId: "connection-1", stunServer: "stun:stun.cloudflare.com:3478" },
    },
  } as const;
}

function token(audience: "chalk-sync" | "chalk-media"): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ aud: audience })}.signature`;
}
