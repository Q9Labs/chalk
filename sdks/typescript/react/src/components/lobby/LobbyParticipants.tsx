import { lobbyRoster, type LobbyParticipant } from "@q9labsai/chalk-client";
import React, { Fragment, lazy, Suspense } from "react";
import { AIBadge } from "../atomic/AIBadge";
import { LobbyAvatar } from "./LobbyAvatar";

const LobbyOthers = lazy(() => import("./LobbyOthers"));

export type { LobbyParticipant };

export type LobbyParticipantsProps = {
  readonly participants?: readonly LobbyParticipant[];
};

/** Who is already in the call, in one line: up to three names, AI participants always named and marked, and the rest behind an "others" list. */
export function LobbyParticipants({ participants = [] }: LobbyParticipantsProps): React.JSX.Element | null {
  if (participants.length === 0) return null;
  const { shown, rest } = lobbyRoster(participants);
  const parts = shown.map((participant, index) => (
    <span key={`${participant.displayName}-${index}`}>
      <b className="font-medium text-[var(--chalk-text)]">{participant.displayName}</b>
      {participant.identityKind === "agent" ? <AIBadge className="ml-1 align-[-0.2em]" /> : null}
    </span>
  ));
  if (rest.length > 0)
    parts.push(
      <Suspense key="others" fallback={<span className="underline decoration-[var(--chalk-line-strong)] underline-offset-[3px]">{rest.length} others</span>}>
        <LobbyOthers participants={participants} count={rest.length} />
      </Suspense>,
    );
  return (
    <div data-testid="lobby.participants" className="m-0 flex w-full items-center gap-2.5 text-left text-(length:--type-body) leading-snug text-[var(--chalk-soft-text)]">
      <span className="flex shrink-0 items-center pl-1.5" aria-hidden="true">
        {shown.slice(0, 3).map((participant, index) => (
          <span key={`${participant.displayName}-${index}`} className="-ml-1.5 inline-flex">
            <LobbyAvatar participant={participant} />
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
