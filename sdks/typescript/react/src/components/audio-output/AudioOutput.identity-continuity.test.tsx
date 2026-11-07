// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "../../../../client/src/space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../../../../client/src/space-client/space-client";
import { control } from "../../../../client/src/space-client/terminal.test.helpers";
import { mediaTrack } from "../../../../client/tests/helpers/media-convergence";
import { useMedia, useParticipants, useSelf } from "../../bindings/hooks";
import { AudioOutput } from "./AudioOutput";

vi.mock("../../bindings/hooks", () => ({ useSelf: vi.fn(), useMedia: vi.fn(), useParticipants: vi.fn(), useSpaceClient: () => ({ media: { observeAudioElement: () => ({ played: () => {}, detach: () => {} }) } }) }));
vi.mock("../participants-panel/participant-volume-context", () => ({ useParticipantVolumeContext: () => null }));
afterEach(() => vi.restoreAllMocks());

it.each(["audioTrack", "screenShareAudioTrack"] as const)("keeps suppressing a known own-device %s when only that device's Sync socket disconnects", async (audioSource) => {
  const platform = createCoreTestPlatform();
  const person = control.participants[0];
  if (!person) throw new Error("fixture requires a participant");
  const identityId = "00000000-0000-4000-8000-000000000001";
  const selfPresence = { participantId: "participant-1", identityId, state: "connected" as const, speaking: false, activeSpeaker: false };
  platform.emitSync({
    ...platform.sync.getSnapshot(),
    control: {
      ...control,
      participants: [
        { ...person, participantId: "participant-1" },
        { ...person, participantId: "own-phone" },
      ],
    },
    presence: { projectionId: "presence", sequence: 0, items: [selfPresence, { ...selfPresence, participantId: "own-phone" }] },
    media: { projectionId: "media", sequence: 0, items: [{ participantId: "own-phone", source: audioSource === "audioTrack" ? "microphone" : "screen", enabled: true, publicationId: "phone-audio" }] },
  });
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("review") }, platform);
  vi.mocked(useSelf).mockImplementation(() => client.getSnapshot().self);
  vi.mocked(useParticipants).mockImplementation(() => client.getSnapshot().participants);
  vi.mocked(useMedia).mockImplementation(() => client.getSnapshot().media);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const track = Object.assign(mediaTrack(), { id: "phone-audio" });
  const root = createRoot(document.createElement("div"));
  try {
    await client.join({ microphone: false, camera: false });
    const render = () => root.render(<AudioOutput participants={[{ id: "own-phone", [audioSource]: track }]} />);
    await act(async () => render());
    expect(play).not.toHaveBeenCalled();
    // LiveEpisode.unregister removes this socket from presence, while the
    // independent SFU connection and already-subscribed publication remain live.
    platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "presence-after-disconnect", sequence: 0, items: [selfPresence] } });
    const phone = client.getSnapshot().participants.roster.find((seat) => seat.participantId === "own-phone");
    expect(phone?.media[audioSource === "audioTrack" ? "microphone" : "screenShare"]).toBe("active");
    await act(async () => render());
    expect(play, "a Sync-only disconnect must not enable self playback").not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.dispose();
  }
});
