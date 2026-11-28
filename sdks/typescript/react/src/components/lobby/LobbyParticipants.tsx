import { lobbyRoster, type LobbyParticipant } from "@q9labsai/chalk-client";
import React, { Fragment, useState } from "react";
import { AIBadge } from "../atomic/AIBadge";
import { Avatar } from "../atomic/Avatar";
import { ChalkPopover } from "../chalk-ui";

export type { LobbyParticipant };

export type LobbyParticipantsProps = {
  readonly participants?: readonly LobbyParticipant[];
};

function ParticipantAvatar({ participant }: { readonly participant: LobbyParticipant }): React.JSX.Element {
  if (participant.identityKind !== "agent") return <Avatar name={participant.displayName} size="xs" generated animated={false} style={{ width: 28, height: 28 }} className="ring-2 ring-[var(--chalk-app-canvas)]" />;
  return (
    <span aria-hidden="true" className="inline-grid size-7 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--chalk-accent)_14%,var(--chalk-app-canvas))] text-[var(--chalk-accent)] ring-2 ring-[var(--chalk-app-canvas)]">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L10.5 13l1.5-.5z" />
      </svg>
    </span>
  );
}

/** Who is already in the call, in one line: up to three names, AI participants always named and marked, and the rest behind an "others" list. */
export function LobbyParticipants({ participants = [] }: LobbyParticipantsProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (participants.length === 0) return null;
  const { shown, rest } = lobbyRoster(participants);
  const parts = shown.map((participant, index) => (
    <span key={`${participant.displayName}-${index}`}>
      <b className="font-medium text-[var(--chalk-text)]">{participant.displayName}</b>
      {participant.identityKind === "agent" ? <AIBadge className="ml-1 align-[0.12em]" /> : null}
    </span>
  ));
  if (rest.length > 0)
    parts.push(
      <ChalkPopover
        key="others"
        open={open}
        onOpenChange={setOpen}
        label="Everyone in this call"
        className="w-[280px] !p-1.5"
        trigger={
          <button type="button" data-testid="lobby.others" className="cursor-pointer border-0 bg-transparent p-0 text-inherit underline decoration-[var(--chalk-line-strong)] underline-offset-[3px]">
            {rest.length} others
          </button>
        }
      >
        <p className="m-0 px-2.5 pb-1.5 pt-2 text-(length:--type-caption) font-medium text-[var(--chalk-muted-text)]">{participants.length} in this call</p>
        {participants.map((participant, index) => (
          <div key={`${participant.displayName}-${index}`} className="flex min-h-10 items-center gap-2.5 px-2.5 text-(length:--type-body-sm)">
            <ParticipantAvatar participant={participant} />
            <span className="min-w-0 truncate">{participant.displayName}</span>
            {participant.identityKind === "agent" ? <AIBadge /> : null}
          </div>
        ))}
      </ChalkPopover>,
    );
  return (
    <div data-testid="lobby.participants" className="m-0 flex w-full items-center gap-2.5 text-left text-(length:--type-body) leading-snug text-[var(--chalk-soft-text)]">
      <span className="flex shrink-0 items-center pl-1.5" aria-hidden="true">
        {shown.slice(0, 3).map((participant, index) => (
          <span key={`${participant.displayName}-${index}`} className="-ml-1.5 inline-flex">
            <ParticipantAvatar participant={participant} />
          </span>
        ))}
      </span>
      <span data-testid="lobby.names" className="min-w-0">
        {parts.map((part, index) => (
          <Fragment key={part.key}>
            {index === 0 ? null : index === parts.length - 1 ? " and " : ", "}
            {part}
          </Fragment>
        ))}
        {participants.length === 1 ? " is" : " are"} in this call
      </span>
    </div>
  );
}
