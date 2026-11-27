// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SpaceClientContext } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { AudioOutput, type AudioParticipant } from "./AudioOutput";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal(
  "MediaStream",
  class {
    readonly #tracks: readonly MediaStreamTrack[];
    constructor(tracks: readonly MediaStreamTrack[]) {
      this.#tracks = tracks;
    }
    getAudioTracks() {
      return [...this.#tracks];
    }
  },
);

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const liveTrack = () =>
  ({
    readyState: "live",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }) as unknown as MediaStreamTrack;

const participant: AudioParticipant = { id: "remote", audioTrack: liveTrack() };

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount() {
  const base = createSnapshot();
  const client = createPreviewClient({
    ...base,
    participants: {
      ...base.participants,
      roster: [
        ...base.participants.roster,
        {
          participantId: "remote",
          displayName: "Remote",
          role: "guest",
          eligibleRoles: ["guest"],
          capabilities: [],
          handRaised: false,
          media: { microphone: "active", camera: "inactive", screenShare: "inactive" },
          presence: { state: "connected", speaking: false, activeSpeaker: false },
        },
      ],
    },
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <SpaceClientContext.Provider value={client}>
        <AudioOutput participants={[participant]} />
      </SpaceClientContext.Provider>,
    ),
  );
  return { client, host, root };
}

it("stays visually silent when remote audio plays", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const { host } = mount();
  await flush();
  expect(host.querySelector("button")).toBeNull();
});

it("records a real autoplay rejection without rendering a prompt", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue({ name: "NotAllowedError" });
  const { client, host } = mount();
  await flush();

  expect(client.getSnapshot().media.audioPlayback.blocked).toBe(true);
  expect(host.querySelector("button")).toBeNull();
});

it("stays unblocked for a play failure that is not an autoplay refusal", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue({ name: "AbortError" });
  const { host } = mount();
  await flush();
  expect(host.querySelector("button")).toBeNull();
});

it("a click anywhere resumes blocked output", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValueOnce({ name: "NotAllowedError" }).mockResolvedValue(undefined);
  const { client } = mount();
  await flush();
  expect(client.getSnapshot().media.audioPlayback.blocked).toBe(true);

  document.body.click();
  await flush();
  expect(client.getSnapshot().media.audioPlayback.blocked).toBe(false);
});

it("a key press resumes blocked output", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValueOnce({ name: "NotAllowedError" }).mockResolvedValue(undefined);
  const { client } = mount();
  await flush();

  document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  await flush();
  expect(client.getSnapshot().media.audioPlayback.blocked).toBe(false);
});
