import { expect, it } from "vitest";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";
import { parseParsedAccessGrant } from "./grant";
import { mediaBootstrap } from "./media-bootstrap";

function ownSFUGrant(capabilities: Record<string, boolean>) {
  const grant: unknown = opaqueAccessGrant("own-sfu");
  if (typeof grant !== "object" || grant === null || !("media" in grant) || typeof grant.media !== "object" || grant.media === null) throw new Error("Unexpected grant fixture");
  const media = { ...grant.media, provider: "chalk_sfu", client_payload: { connectionId: "connection-1", episodeRef: "episode-ref", iceServers: [], capabilities } };
  return parseParsedAccessGrant({ ...grant, media });
}

it("carries the unified signaling capability from the grant into the media bootstrap", () => {
  const bootstrap = mediaBootstrap(ownSFUGrant({ serverLayerAdaptation: true, subscriptionState: true, iceRestart: true, unifiedSignaling: true }).media);

  expect(bootstrap.capabilities?.unifiedSignaling).toBe(true);
});

it("treats a grant from an API that predates unified signaling as not supporting it", () => {
  const bootstrap = mediaBootstrap(ownSFUGrant({ serverLayerAdaptation: true, subscriptionState: true, iceRestart: true }).media);

  expect(bootstrap.capabilities).toMatchObject({ iceRestart: true, unifiedSignaling: false });
});
