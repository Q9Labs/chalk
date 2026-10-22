import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { createPreviewClient, createSnapshot, PreviewSpaceView } from "@q9labsai/chalk-react/preview";
import { useState } from "react";

const participant = (participantId: string, displayName: string): SpaceSnapshot["participants"]["roster"][number] => ({
  participantId,
  displayName,
  role: "guest",
  eligibleRoles: ["guest"],
  capabilities: [],
  handRaised: false,
  media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
  presence: { state: "connected", speaking: false, activeSpeaker: false },
});
const base = createSnapshot(["sendReaction", "raiseHand"]);
const reactions: string[] = [];
const client = createPreviewClient(
  {
    ...base,
    connection: { ...base.connection, status: "live" },
    self: { ...base.self, participantId: "self", displayName: "You", role: "guest" },
    participants: { roster: [participant("self", "You"), participant("peer", "Nora")], admissionQueue: [] },
  },
  {
    onCommand: (command) => {
      if (command.type === "sendReaction") reactions.push(command.reaction);
    },
  },
);

declare global {
  interface Window {
    __toastLayering: {
      peerHand: () => void;
      state: () => { raised: boolean; reactions: readonly string[] };
    };
  }
}
window.__toastLayering = {
  peerHand: () => client.updateSnapshot((snapshot) => ({ ...snapshot, participants: { ...snapshot.participants, roster: snapshot.participants.roster.map((person) => (person.participantId === "peer" ? { ...person, handRaised: true } : person)) } })),
  state: () => ({ raised: client.getSnapshot().self.handRaised, reactions }),
};

export function ToastLayeringFixture() {
  const [error, setError] = useState<string | undefined>("setCameraEnabled belongs to an inactive connection");
  return <PreviewSpaceView client={client} spaceName="Notice layering" generatedAvatars={false} commandError={error} onDismissCommandError={() => setError(undefined)} features={{ sounds: false, recording: false }} />;
}
