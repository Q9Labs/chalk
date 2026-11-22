import type { components } from "../generated/screen-annotation-v1";

type Wire = components["schemas"];

export function applyChange(state: Wire["State"], frame: Wire["ServerChange"]): Wire["State"] {
  const { change, fence, revision } = frame;
  const next = { ...state, fence, revision };
  switch (change.kind) {
    case "upsert":
      return { ...next, marks: [...state.marks.filter((mark) => mark.draft.mark_id !== change.mark.draft.mark_id), change.mark].sort((a, b) => a.created_revision - b.created_revision) };
    case "remove":
      return { ...next, marks: state.marks.filter((mark) => mark.draft.mark_id !== change.mark_id) };
    case "clear":
      return { ...next, marks: change.participant_id === null ? [] : state.marks.filter((mark) => mark.author.participant_id !== change.participant_id) };
    case "control":
      return { ...next, paused: change.paused, access: change.access };
  }
}

function isCommittedPreview(state: Wire["State"], draftId: string | undefined): boolean {
  return draftId !== undefined && state.marks.some((mark) => mark.draft.mark_id === draftId);
}

export function isObsoletePresence(state: Wire["State"], frame: Wire["ServerPresence"], previous: Wire["ServerPresence"] | undefined): boolean {
  return Boolean(previous && previous.server_at_ms > frame.server_at_ms) || isCommittedPreview(state, frame.draft?.mark_id);
}
