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

/** The privacy-limited roster and AI disclosure a joiner must see before entering. */
export function LobbyNotice({ participants = [] }: LobbyNoticeProps): React.JSX.Element | null {
  if (participants.length === 0) return null;
  const agents = participants.filter((participant) => participant.identityKind === "agent");
  return (
    <div data-testid="lobby.notice" className="flex w-full flex-col items-center gap-2 text-center">
      <div className="flex items-center gap-2 text-sm text-[var(--chalk-soft-text)]">
        <span className="flex shrink-0 items-center pl-1" aria-hidden="true">
          {participants.slice(0, 3).map((participant, index) => (
            <Avatar key={`${participant.displayName}-${index}`} name={participant.displayName} showAIBadge={participant.identityKind === "agent"} size="xs" generated animated={false} className="-ml-1 ring-2 ring-[var(--chalk-surface)]" />
          ))}
        </span>
        <span>{lobbySummary(participants)}</span>
      </div>
      {agents.map((participant, index) => (
        <div key={`${participant.displayName}-${index}`} data-testid="lobby.ai-notice" className="flex items-center gap-2 text-xs leading-[1.4] text-[var(--chalk-muted-text)]">
          <Avatar name={participant.displayName} showAIBadge size="xs" generated animated={false} />
          <span>{agentLobbyNotice(participant)}</span>
        </div>
      ))}
    </div>
  );
}

export function lobbySummary(participants: readonly LobbyParticipant[]): string {
  const names = participants.map((participant) => participant.displayName);
  if (names.length === 1) return `${names[0]} is in this call`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in this call`;
  return `${names[0]} and ${names[1]} and ${names.length - 2} others are in this call`;
}

export function agentLobbyNotice(participant: LobbyParticipant): string {
  return participant.notice?.trim() || `${participant.displayName}, an AI participant, is in this call.`;
}
