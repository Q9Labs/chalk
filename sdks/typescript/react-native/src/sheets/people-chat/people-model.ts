import type { AdmissionRequest, Participant } from "@q9labsai/chalk-client";

export type PeopleRow =
  | { readonly kind: "section"; readonly key: string; readonly label: string }
  | { readonly kind: "waiting"; readonly key: string; readonly request: AdmissionRequest }
  | { readonly kind: "hand"; readonly key: string; readonly participant: Participant; readonly order: number }
  | { readonly kind: "person"; readonly key: string; readonly participant: Participant; /** Place in the raised-hands queue; set only while two or more hands are up. */ readonly handNumber: number | null }
  | { readonly kind: "none"; readonly key: string; readonly query: string };

export type PeopleInput = {
  readonly roster: readonly Participant[];
  /** People waiting to join; empty for anyone who can't let people in. */
  readonly waiting: readonly AdmissionRequest[];
  /** Participant ids with a raised hand, the one raised first at the front. */
  readonly handOrder: readonly string[];
  readonly query: string;
};

/**
 * The People list, top to bottom: people waiting, the raised-hands queue (only once two hands are up,
 * since one hand needs no order), then everyone in the call. A search hides the queue.
 */
export function peopleRows({ roster, waiting, handOrder, query }: PeopleInput): readonly PeopleRow[] {
  const q = query.trim().toLowerCase();
  const rows: PeopleRow[] = [];
  const byId = new Map(roster.map((participant) => [participant.participantId, participant]));
  const raised = handOrder.filter((id) => byId.get(id)?.handRaised);
  const numbered = raised.length > 1;
  let headed = false;
  const headInTheCall = () => {
    if (headed) return;
    headed = true;
    rows.push({ kind: "section", key: "section.call", label: "In the call" });
  };

  if (waiting.length > 0) {
    rows.push({ kind: "section", key: "section.waiting", label: "Waiting" });
    for (const request of waiting) rows.push({ kind: "waiting", key: `waiting.${request.requestId}`, request });
    headInTheCall();
  }
  if (!q && numbered) {
    rows.push({ kind: "section", key: "section.hands", label: "Raised hands" });
    raised.forEach((id, index) => {
      const participant = byId.get(id);
      if (participant) rows.push({ kind: "hand", key: `hand.${id}`, participant, order: index + 1 });
    });
    headInTheCall();
  }

  const people = roster.filter((participant) => !q || participant.displayName.toLowerCase().includes(q));
  if (people.length === 0) rows.push({ kind: "none", key: "none", query: query.trim() });
  for (const participant of people) {
    const index = raised.indexOf(participant.participantId);
    rows.push({ kind: "person", key: `person.${participant.participantId}`, participant, handNumber: numbered && index >= 0 ? index + 1 : null });
  }
  return rows;
}

/**
 * Who raised a hand first. The client only says whether a hand is up, so this remembers the order
 * the lists saw hands go up in; people who join with a hand already raised count from when they appear.
 */
export function nextHandOrder(previous: readonly string[], roster: readonly Participant[]): readonly string[] {
  const raised = new Set(roster.filter((participant) => participant.handRaised).map((participant) => participant.participantId));
  const kept = previous.filter((id) => raised.has(id));
  const added = [...raised].filter((id) => !kept.includes(id));
  return added.length === 0 && kept.length === previous.length ? previous : [...kept, ...added];
}
