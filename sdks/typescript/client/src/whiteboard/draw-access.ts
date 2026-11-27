import type { ChalkWhiteboardDrawPolicy, ChalkWhiteboardSummary } from "./types";

export type ChalkWhiteboardDrawAccess = {
  readonly engine: { readonly status: ChalkWhiteboardSummary["status"] };
  readonly access: {
    readonly canDraw: boolean;
    readonly policy: ChalkWhiteboardDrawPolicy | null;
  };
};

/**
 * Whether this person can draw on the board. Sync decides from the call's policy, their role and the host's choice for them; until the board subscription is live, the role default stands in. A Sync without the drawing policy doesn't report role changes to the board, so there the live role still limits drawing.
 */
export function canDrawWhiteboard(whiteboard: ChalkWhiteboardDrawAccess, roleDefault: boolean): boolean {
  if (whiteboard.engine.status === "unsubscribed") return roleDefault;
  if (whiteboard.access.policy === null) return roleDefault && whiteboard.access.canDraw;
  return whiteboard.access.canDraw;
}
