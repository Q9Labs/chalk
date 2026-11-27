import { readSpaceInviteToken, type ChalkPublicClient, type LobbyParticipant } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";

/** Who is already in the call, read from the invite so the entrance can say so before the visitor joins. */
export function useLobbyParticipants(client: ChalkPublicClient, inviteCode: string | undefined): readonly LobbyParticipant[] {
  const [participants, setParticipants] = useState<readonly LobbyParticipant[]>([]);
  const inviteToken = inviteCode ?? readSpaceInviteToken(globalThis.location?.hash ?? "");
  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    void client.prepareSpaceEntrance(inviteToken).then(
      (preparation) => {
        if (!cancelled) setParticipants(preparation.participants);
      },
      () => {
        if (!cancelled) setParticipants([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, inviteToken]);
  return participants;
}
