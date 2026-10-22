import type { ChalkWhiteboardDrawPolicy } from "@q9labsai/chalk-client";
import { useCallback, useMemo } from "react";
import { useCan, useParticipants, useSelf, useSpaceClient, useWhiteboard } from "../../bindings/hooks";
import type { BoardToast } from "./board-toasts";

export type WhoCanDraw = {
  readonly policy: ChalkWhiteboardDrawPolicy;
  /** Everyone in the call who is not a host, because hosts can always draw under hosts only and picked people. */
  readonly people: readonly { readonly id: string; readonly name: string; readonly picked: boolean }[];
  readonly onPolicy: (policy: ChalkWhiteboardDrawPolicy) => void;
  readonly onPick: (id: string, picked: boolean) => void;
};

/** The host's call-wide drawing control. Undefined for people who aren't hosts and on Sync servers without draw_policy_v1. */
export function useWhoCanDraw(toast: (toast: BoardToast) => void): WhoCanDraw | undefined {
  const client = useSpaceClient();
  const isHost = useCan("manageWhiteboard");
  const self = useSelf();
  const { roster } = useParticipants();
  const { access } = useWhiteboard();
  const transport = client.whiteboard.transport();

  const people = useMemo(
    () =>
      roster
        .filter((person) => person.participantId !== self.participantId && !person.capabilities.includes("manageWhiteboard"))
        .map((person) => ({
          id: person.participantId,
          name: person.displayName,
          picked: access.permissions.some((permission) => permission.participantId === person.participantId && permission.canDraw),
        })),
    [roster, self.participantId, access.permissions],
  );

  const onPolicy = useCallback(
    (policy: ChalkWhiteboardDrawPolicy) => {
      transport?.setDrawPolicy?.(policy).catch(() => toast({ type: "error", message: "Could not change who can draw. Try again." }));
    },
    [transport, toast],
  );

  const onPick = useCallback(
    (id: string, picked: boolean) => {
      transport?.setDrawPermission(id, picked).catch(() => toast({ type: "error", message: "Could not change who can draw. Try again." }));
    },
    [transport, toast],
  );

  if (!isHost || access.policy === null || !transport?.setDrawPolicy) return undefined;
  return { policy: access.policy, people, onPolicy, onPick };
}
