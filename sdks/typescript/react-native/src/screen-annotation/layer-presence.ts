import type { ScreenAnnotationDraft, ScreenAnnotationPresence, ScreenAnnotationState, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import { LASER_TRAIL_MS } from "@q9labsai/chalk-screen-annotation";
import { hasTarget } from "./model";

export type CommittingMark = { readonly target: ScreenAnnotationTarget; readonly draft: ScreenAnnotationDraft; readonly untilRevision?: number };

export function layerPresenceFor({
  presence,
  localSample,
  committing,
  target,
  allowed,
  open,
  state,
  person,
  nowMs,
}: {
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly state: ScreenAnnotationState;
  readonly person: { readonly id: string; readonly name: string };
  readonly localSample: ScreenAnnotationPresence | null;
  readonly committing: CommittingMark | null;
  readonly target: ScreenAnnotationTarget;
  readonly allowed: boolean;
  readonly open: boolean;
  readonly nowMs: number;
}) {
  const local = localSample?.fence === target.fence && allowed && open ? localSample : null;
  const waiting = committing && hasTarget(state, committing.target) && (committing.untilRevision === undefined || state.revision < committing.untilRevision);
  const pending: ScreenAnnotationPresence | null =
    waiting && allowed
      ? {
          type: "annotation_presence",
          layer_id: target.layerId,
          fence: target.fence,
          author: { participant_id: person.id, display_name: person.name, color: state.access.default_color },
          server_at_ms: nowMs,
          expires_at_ms: nowMs + 1000,
          cursor: null,
          draft: committing.draft,
        }
      : null;

  const localTouch = state.layer.burned_in && local?.cursor ? { point: local.cursor.point, untilMs: local.server_at_ms + LASER_TRAIL_MS } : undefined;
  const localPreview = local && (state.layer.burned_in ? { ...local, cursor: null } : local);
  const peers = presence.filter(({ author }) => author.participant_id !== person.id);
  const remote = state.layer.burned_in ? peers.map((peer) => ({ ...peer, draft: null })) : peers;
  return { layerPresence: [...remote, ...(pending ? [pending] : []), ...(localPreview ? [localPreview] : [])], localTouch };
}
