import { describe, expect, it } from "vitest";
import { iceServersFor } from "../media/ice-servers";
import type { ParticipantMediaAccess } from "./grant";
import { accessGrant } from "./grant.test.helpers";
import { mediaBootstrap } from "./media-bootstrap";

describe("media bootstrap", () => {
  const cloudflare = accessGrant(Date.now() + 60_000, "a").media;
  const chalk: ParticipantMediaAccess = {
    token: cloudflare.token,
    expiresAt: cloudflare.expiresAt,
    provider: "chalk_sfu",
    clientPayload: { connectionId: "own-1", episodeRef: "episode-ref", iceServers: [], capabilities: { serverLayerAdaptation: false, iceRestart: false } },
  };

  it("keeps the Cloudflare bootstrap as it was", () => {
    expect(mediaBootstrap(cloudflare)).toEqual({ connectionId: "connection-1", stunServer: "stun:stun.cloudflare.com:3478" });
    expect(iceServersFor(mediaBootstrap(cloudflare))).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });

  it("gives the own SFU no Cloudflare STUN server", () => {
    expect(mediaBootstrap(chalk)).toEqual({ connectionId: "own-1", iceServers: [] });
    expect(iceServersFor(mediaBootstrap(chalk))).toEqual([]);
    const withStun: ParticipantMediaAccess = { ...chalk, clientPayload: { ...chalk.clientPayload, iceServers: [{ urls: ["stun:own.test:3478"] }] } };
    expect(iceServersFor(mediaBootstrap(withStun))).toEqual([{ urls: ["stun:own.test:3478"] }]);
  });

  it("throws for a provider this SDK does not know instead of running it as Cloudflare", () => {
    const unknown = JSON.parse(JSON.stringify({ ...cloudflare, provider: "later_sfu" }));
    expect(() => mediaBootstrap(unknown)).toThrowError(TypeError);
  });
});
