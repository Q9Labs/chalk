// Joins the Space with the SDK under test. media-off-resend-instrument.js runs first and defines window.proof.
import { createSpaceClientForPlatform } from "@q9labsai/chalk-client/effect";

window.proof.join = async (config) => {
  const client = createSpaceClientForPlatform({ space: config.space, baseUrl: config.baseUrl, getAccess: (request) => window.proofAccess(request) }, { syncUrl: config.syncUrl });
  window.proofClient = client;
  await client.join({ displayName: config.name, microphone: config.microphone ?? true, camera: false });
  return client.getSnapshot().self.participantId;
};
