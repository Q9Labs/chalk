import React from "react";
import { Avatar } from "../atomic/Avatar";

export interface LobbyParticipant {
  readonly displayName: string;
  readonly identityKind?: "user" | "agent" | "guest";
  readonly notice?: string;
}

export type LobbyNoticeProps = {
  readonly participants?: readonly LobbyParticipant[];
};

/** Who is already in the call, with AI participants marked, and the notice an AI participant supplied about what it does. */
export function LobbyNotice({ participants = [] }: LobbyNoticeProps): React.JSX.Element | null {
  if (participants.length === 0) return null;
  const notice = lobbyNotice(participants);
  return (
    <div data-testid="lobby.notice" className="flex w-full flex-col items-start gap-1 text-left">
      <div className="flex items-center gap-2 text-sm text-[var(--chalk-soft-text)]">
        <span className="flex shrink-0 items-center pl-1" aria-hidden="true">
          {participants.slice(0, 3).map((participant, index) => (
            <Avatar key={`${participant.displayName}-${index}`} name={participant.displayName} size="xs" generated animated={false} className="-ml-1 ring-2 ring-[var(--chalk-surface)]" />
          ))}
        </span>
        <span>{lobbySummary(participants)}</span>
      </div>
      {notice ? (
        <p data-testid="lobby.ai-notice" className="m-0 text-xs leading-[1.4] text-[var(--chalk-muted-text)]">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

export function lobbySummary(participants: readonly LobbyParticipant[]): string {
  const names = participants.map((participant) => (participant.identityKind === "agent" ? `${participant.displayName} (AI)` : participant.displayName));
  if (names.length === 1) return `${names[0]} is in this call`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in this call`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are in this call`;
  const rest = participants.slice(2);
  const aiRest = rest.filter((participant) => participant.identityKind === "agent").length;
  return `${names[0]}, ${names[1]} and ${rest.length} others${aiRest > 0 ? ` (${aiRest} AI)` : ""} are in this call`;
}

/** Only what an AI participant says about what it does; the inline "(AI)" already says that it is one. */
export function lobbyNotice(participants: readonly LobbyParticipant[]): string {
  return participants
    .filter((participant) => participant.identityKind === "agent")
    .map((participant) => participant.notice?.trim())
    .filter(Boolean)
    .join(" ");
}
