import type { LobbyParticipant } from "@q9labsai/chalk-client";
import React from "react";
import { Avatar } from "../atomic/Avatar";

export function LobbyAvatar({ participant }: { readonly participant: LobbyParticipant }): React.JSX.Element {
  return <Avatar name={participant.displayName} size="xs" generated animated={false} style={{ width: 28, height: 28 }} className="ring-2 ring-[var(--chalk-app-canvas)]" />;
}
