import type { LobbyParticipant } from "@q9labsai/chalk-client";
import React, { useState } from "react";
import { AIBadge } from "../atomic/AIBadge";
import { ChalkPopover } from "../chalk-ui";
import { LobbyAvatar } from "./LobbyAvatar";

/** The "N others" button and the list of everyone behind it. It loads on its own so the entrance route does not carry the popover. */
export default function LobbyOthers({ participants, count }: { readonly participants: readonly LobbyParticipant[]; readonly count: number }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <ChalkPopover
      open={open}
      onOpenChange={setOpen}
      label="Everyone in this call"
      className="w-[280px] !p-1.5"
      trigger={
        <button type="button" data-testid="lobby.others" className="cursor-pointer border-0 bg-transparent p-0 text-inherit underline decoration-[var(--chalk-line-strong)] underline-offset-[3px]">
          {count} others
        </button>
      }
    >
      <p className="m-0 px-2.5 pb-1.5 pt-2 text-(length:--type-caption) font-medium text-[var(--chalk-muted-text)]">{participants.length} in this call</p>
      {participants.map((participant, index) => (
        <div key={`${participant.displayName}-${index}`} className="flex min-h-10 items-center gap-2.5 px-2.5 text-(length:--type-body-sm)">
          <LobbyAvatar participant={participant} />
          <span className="min-w-0 truncate">{participant.displayName}</span>
          {participant.identityKind === "agent" ? <AIBadge /> : null}
        </div>
      ))}
    </ChalkPopover>
  );
}
