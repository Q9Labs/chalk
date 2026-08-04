import { Effect, Scope } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as rootSurface from "../index";
import { ConnectionError } from "../session/types";
import { createEffectSpaceClient, type EffectSpaceClient } from "./effect";
import { normalizeClientError, SpaceClientError } from "./errors";
import type { AccessGrant } from "./index";
import { createSpaceClient } from "./space-client";
import type { SpaceClient } from "./types";

describe("SpaceClient public contract", () => {
  it("exposes the five ratified controllers and no legacy client", () => {
    const client = createSpaceClient({ space: "design-review", getAccess: () => Promise.reject(new Error("not joined")) });

    expect(Object.keys(client.media).sort()).toEqual(["acceptRequest", "declineRequest", "selectCamera", "selectMicrophone", "selectSpeaker", "setCameraEnabled", "setMicrophoneEnabled", "setScreenShareEnabled"]);
    expect(Object.keys(client.chat).sort()).toEqual(["files", "loadOlder", "markRead", "send"]);
    expect(Object.keys(client.participants).sort()).toEqual(["admit", "assignRole", "deny", "lowerHand", "mute", "raiseHand", "remove", "renameSelf", "requestMedia", "stopScreenShare", "stopVideo"]);
    expect(Object.keys(client.reactions)).toEqual(["send"]);
    expect(Object.keys(client.whiteboard)).toEqual(["transport"]);
    expect(rootSurface).not.toHaveProperty("ChalkSession");
    expect(rootSurface).not.toHaveProperty("ParticipantAccess");
    expect(rootSurface).not.toHaveProperty("parseAccessGrant");
    expect(rootSurface).not.toHaveProperty("requireAccessGrant");
    expect(rootSurface).not.toHaveProperty("accessGrantFromParsed");

    client.dispose();
  });

  it("keeps AccessGrant opaque and the default entry Promise-only", () => {
    expectTypeOf<AccessGrant>().not.toHaveProperty("subject");
    expectTypeOf<AccessGrant>().not.toHaveProperty("sync");
    expectTypeOf<AccessGrant>().not.toHaveProperty("media");
    expectTypeOf<ReturnType<SpaceClient["join"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<SpaceClient["endEpisode"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<EffectSpaceClient["join"]>>().toEqualTypeOf<Effect.Effect<void, SpaceClientError>>();
    expectTypeOf<ReturnType<typeof createEffectSpaceClient>>().toEqualTypeOf<Effect.Effect<EffectSpaceClient, never, Scope.Scope>>();

    const effect = createEffectSpaceClient({ space: "design-review", getAccess: () => Promise.reject(new Error("not joined")) });
    expect(Effect.isEffect(effect)).toBe(true);
  });

  it("maps internal failures to noun.condition codes", () => {
    const access = normalizeClientError(new ConnectionError({ code: "invalid_access", action: "join", recoverable: true, message: "rejected" }));
    const ended = normalizeClientError(new ConnectionError({ code: "session_ended", action: null, recoverable: false, message: "ended" }));

    expect(access).toMatchObject({ _tag: "SpaceClientError", code: "access.invalid", recoverable: true });
    expect(ended).toMatchObject({ _tag: "SpaceClientError", code: "episode.ended", recoverable: false });
  });
});
