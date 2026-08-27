import type React from "react";

import { ParticipantTile } from "../participant-tile/ParticipantTile";

type EntranceParticipantPreviewProps = {
  readonly displayName: string;
  readonly microphone: boolean;
  readonly generatedAvatars: boolean;
};

export function EntranceParticipantPreview({ displayName, microphone, generatedAvatars }: EntranceParticipantPreviewProps): React.JSX.Element {
  const participantName = displayName.trim() || "You";

  return <ParticipantTile participant={{ id: "entrance-preview", displayName: participantName, isLocal: true, isMuted: !microphone, isVideoEnabled: false }} aspectRatio="fill" generatedAvatars={generatedAvatars} className="h-full w-full rounded-none border-0" />;
}
