import type { Capability } from "@q9labsai/chalk-client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { ParticipantsPanel } from "./ParticipantsPanel";

it.each([
  { role: "owner", capabilities: ["endEpisode"], host: true },
  { role: "custom-moderator", capabilities: ["endEpisode"], host: true },
  { role: "host", capabilities: [], host: false },
] satisfies { role: string; capabilities: Capability[]; host: boolean }[])("uses authority, not the $role role name, for the Host badge", ({ role, capabilities, host }) => {
  const base = createSnapshot();
  const client = createPreviewClient({
    ...base,
    participants: {
      ...base.participants,
      roster: [{ participantId: "peer", displayName: "Nora", role, eligibleRoles: [], capabilities, handRaised: false, media: { microphone: "active", camera: "active", screenShare: "inactive" }, presence: { state: "connected", speaking: false, activeSpeaker: false } }],
    },
  });
  try {
    const html = renderToStaticMarkup(
      <ChalkProvider client={client}>
        <ParticipantsPanel generatedAvatars={false} />
      </ChalkProvider>,
    );
    expect(html.includes(">Host</span>")).toBe(host);
  } finally {
    client.dispose();
  }
});
