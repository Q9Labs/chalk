import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationState, WhiteboardSlice } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";
import { ChalkPopover } from "../chalk-ui";
import { StageIcon } from "../stage/StageIcon";
import { canDraw, visibleMarks } from "./model";

export interface AnnotationPerson {
  readonly id: string;
  readonly name: string;
  readonly roleCanDraw: boolean;
  readonly managesPolicy: boolean;
}

const policies = [
  { value: "everyone", label: "Everyone" },
  { value: "hosts", label: "Hosts only" },
  { value: "picked", label: "Picked people" },
] satisfies readonly { value: ScreenAnnotationState["access"]["draw_policy"]; label: string }[];

export const annotationControl =
  "flex h-8 items-center gap-1.5 rounded-full bg-[var(--chalk-overlay-strong)] px-3 text-xs font-semibold text-[var(--chalk-on-overlay)] shadow-sm hover:bg-[var(--chalk-overlay-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--chalk-focus)] disabled:opacity-50";

export function AnnotationAccess({
  client,
  state,
  actorId,
  people,
  grants,
  command,
}: {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly actorId: string;
  readonly people: readonly AnnotationPerson[];
  readonly grants?: WhiteboardSlice["access"]["permissions"];
  readonly command: (command: ScreenAnnotationCommand) => void;
}) {
  const [, tick] = useState(0);
  const now = client.serverNowMs();
  const { access, paused } = state;
  const requests = access.requests.filter((request) => request.expires_at_ms > now);
  const nextExpiry = requests.reduce((next, request) => Math.min(next, request.expires_at_ms), Infinity);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [timer] Hide expired moderation requests without relying on a Sync expiry frame.
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => tick((value) => value + 1), Math.max(1, nextExpiry - client.serverNowMs() + 1));
    return () => clearTimeout(timer);
  }, [client, nextExpiry]);

  const ownRequest = requests.some((request) => request.participant_id === actorId);
  const otherRequests = requests.filter((request) => request.participant_id !== actorId);
  const policy = access.draw_policy;
  const isSharer = actorId === state.layer.sharer_id;
  const cannotDraw = !canDraw(state, actorId);
  const blockedLabel = paused && !isSharer ? "Marks are paused" : policy === "hosts" ? "Only hosts can draw" : "Drawing isn’t available";
  return (
    <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
      {cannotDraw ? (
        !access.can_draw && policy !== "hosts" && (!paused || isSharer) ? (
          <button type="button" className={annotationControl} disabled={ownRequest} onClick={() => command({ kind: "request_draw" })}>
            <StageIcon name="hand" size={14} /> {ownRequest ? "Request sent" : "Raise hand to draw"}
          </button>
        ) : (
          <span role="status" className={annotationControl}>
            {blockedLabel}
          </span>
        )
      ) : null}
      {access.can_moderate ? (
        <button type="button" className={annotationControl} onClick={() => command({ kind: "pause", paused: !paused })}>
          <StageIcon name="pause" size={14} /> {paused ? "Resume marks" : "Pause marks"}
        </button>
      ) : null}
      <ChalkPopover
        label="Who can draw"
        side="top"
        trigger={
          <button type="button" className={annotationControl}>
            Who can draw{access.can_manage_policy && otherRequests.length ? ` · ${otherRequests.length} requested` : ""}
          </button>
        }
      >
        <div className="grid w-64 max-w-full gap-3 p-2 text-sm">
          {access.can_manage_policy ? (
            <fieldset className="grid gap-1">
              <legend className="pb-1 font-semibold">Who can draw</legend>
              {policies.map(({ value, label }) => (
                <label key={value} className="flex items-center gap-2">
                  <input type="radio" name={state.layer.layer_id + "-draw-policy"} checked={policy === value} onChange={() => command({ kind: "set_policy", policy: value })} />
                  {label}
                </label>
              ))}
            </fieldset>
          ) : (
            <p>{policies.find((entry) => entry.value === policy)?.label} can draw.</p>
          )}
          {access.can_manage_policy && otherRequests.length ? (
            <div className="grid gap-2">
              <p className="font-semibold">Requests to draw</p>
              <ul className="grid gap-2">
                {otherRequests.map((request) => {
                  const person = people.find((entry) => request.participant_id === entry.id);
                  return (
                    <li key={request.request_id} className="grid gap-1">
                      <bdi className="truncate">{person?.name ?? "Participant"}</bdi>
                      <div className="flex gap-2">
                        <button type="button" className="underline" aria-label={`Allow ${person?.name ?? "participant"} to draw`} onClick={() => command({ kind: "decide_draw", request_id: request.request_id, allow: true })}>
                          Allow
                        </button>
                        <button type="button" className="underline" aria-label={`Decline request from ${person?.name ?? "participant"}`} onClick={() => command({ kind: "decide_draw", request_id: request.request_id, allow: false })}>
                          Decline
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          <AnnotationContributors state={state} now={now} people={people} grants={grants} command={command} />
        </div>
      </ChalkPopover>
    </div>
  );
}

function AnnotationContributors({
  state,
  now,
  people,
  grants,
  command,
}: {
  readonly state: ScreenAnnotationState;
  readonly now: number;
  readonly people: readonly AnnotationPerson[];
  readonly grants?: WhiteboardSlice["access"]["permissions"];
  readonly command: (command: ScreenAnnotationCommand) => void;
}) {
  const contributors = new Map<string, { name: string; color: string; count: number }>();
  for (const mark of visibleMarks(state, now)) {
    const { participant_id, display_name, color } = mark.author;
    const previous = contributors.get(participant_id);
    contributors.set(participant_id, { name: display_name, color, count: (previous?.count ?? 0) + 1 });
  }
  const policy = state.access.draw_policy;
  const canManage = Boolean(grants && state.access.can_manage_policy && policy !== "hosts");
  const entries = people.filter((person) => contributors.has(person.id) || (canManage && (policy === "everyone" || !person.managesPolicy)));
  for (const [id, contributor] of contributors) {
    if (!entries.some((person) => person.id === id)) entries.push({ id, name: contributor.name, roleCanDraw: false, managesPolicy: false });
  }
  return entries.length ? (
    <ul className="grid gap-2" aria-label="Drawing permissions and marks by person">
      {entries.map((person) => {
        const contributor = contributors.get(person.id);
        const grant = grants?.find((entry) => entry.participantId === person.id);
        const allowed = grant?.canDraw ?? (policy === "everyone" && person.roleCanDraw);
        const canSetGrant = canManage && people.includes(person) && (policy === "everyone" || !person.managesPolicy);
        return (
          <li key={person.id} className="grid gap-1">
            <span className="flex items-center gap-1.5">
              {contributor ? <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: contributor.color }} /> : null}
              <bdi className="truncate">{person.name}</bdi>
              {contributor ? (
                <span className="shrink-0 text-xs">
                  · {contributor.count} {contributor.count === 1 ? "mark" : "marks"}
                </span>
              ) : null}
            </span>
            <span className="flex flex-wrap gap-2">
              {canSetGrant ? (
                <label className="flex items-center gap-1">
                  <input type="checkbox" aria-label={`Let ${person.name} draw`} checked={allowed} onChange={(event) => command({ kind: "set_draw_permission", participant_id: person.id, allow: event.target.checked })} />
                  Can draw
                </label>
              ) : null}
              {contributor && state.access.can_moderate ? (
                <button type="button" className="underline" aria-label={`Clear marks by ${person.name}`} onClick={() => command({ kind: "clear", scope: { kind: "participant", participant_id: person.id } })}>
                  Clear marks
                </button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  ) : null;
}
