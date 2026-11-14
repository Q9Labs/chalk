import { expect, it } from "vitest";
import { chalkSFUGrant } from "../space-client/core.test.helpers";
import { mediaBootstrap } from "./media-bootstrap";

it("carries the unified signaling capability from the grant into the media bootstrap", () => {
  const bootstrap = mediaBootstrap(chalkSFUGrant({ serverLayerAdaptation: true, subscriptionState: true, iceRestart: true, unifiedSignaling: true }).media);

  expect(bootstrap.capabilities?.unifiedSignaling).toBe(true);
});

it("treats a grant from an API that predates unified signaling as not supporting it", () => {
  const bootstrap = mediaBootstrap(chalkSFUGrant({ serverLayerAdaptation: true, subscriptionState: true, iceRestart: true }).media);

  expect(bootstrap.capabilities).toMatchObject({ iceRestart: true, unifiedSignaling: false });
});

it.each(["https://direct.example.test", "https://direct.example.test/"])("carries the direct door %s from the grant into the media bootstrap as a bare origin", (advertised) => {
  const bootstrap = mediaBootstrap(chalkSFUGrant({ unifiedSignaling: true, directSignalingUrl: advertised }).media);

  expect(bootstrap.capabilities?.directSignalingUrl).toBe("https://direct.example.test");
});

it.each(["http://direct.example.test", "https://direct.example.test/v1/sync", "https://user@direct.example.test", "direct.example.test", 7, null])("drops an advertised direct door that is not a bare https origin: %j", (advertised) => {
  const bootstrap = mediaBootstrap(chalkSFUGrant({ unifiedSignaling: true, directSignalingUrl: advertised }).media);

  expect(bootstrap.capabilities).not.toHaveProperty("directSignalingUrl");
});

it("advertises no direct door when the grant has none", () => {
  expect(mediaBootstrap(chalkSFUGrant({ unifiedSignaling: true }).media).capabilities).not.toHaveProperty("directSignalingUrl");
});
