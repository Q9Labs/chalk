import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationState, WhiteboardSlice } from "@q9labsai/chalk-client";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";
import { HugeiconsIcon } from "@hugeicons/react";
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

export function AnnotationAccess({
  client,
  state,
  actorId,
  people,
  grants,
  command,
  side = "top",
  hints = false,
}: {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly actorId: string;
  readonly people: readonly AnnotationPerson[];
  readonly grants?: WhiteboardSlice["access"]["permissions"];
  readonly command: (command: ScreenAnnotationCommand) => void;
  /** Which way the Who can draw panel opens. */
  readonly side?: "top" | "bottom";
  /** Show a tooltip on each control, for looks that drop the text labels. */
  readonly hints?: boolean;
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
  const requested = access.can_manage_policy ? otherRequests.length : 0;
  const whoLabel = `Who can draw${requested ? ` · ${requested} requested` : ""}`;
  return (
    <>
      <DrawAccessPrompt state={state} actorId={actorId} ownRequest={ownRequest} command={command} />
      {access.can_moderate ? (
        <button type="button" className="chalk-ann-btn" onClick={() => command({ kind: "pause", paused: !paused })}>
          <StageIcon name="pause" size={15} />
          <span className="chalk-ann-label">{paused ? "Resume marks" : "Pause marks"}</span>
        </button>
      ) : null}
      <ChalkPopover
        label="Who can draw"
        side={side}
        tooltip={hints ? "Who can draw" : undefined}
        trigger={
          <button type="button" className="chalk-ann-btn">
            <HugeiconsIcon icon={UserGroupIcon} size={16} aria-hidden="true" />
            <span className="chalk-ann-label">{whoLabel}</span>
            {requested ? (
              <span aria-hidden="true" className="chalk-ann-badge">
                {requested}
              </span>
            ) : null}
          </button>
        }
      >
        <div className="chalk-ann-panel">
          {access.can_manage_policy ? (
            <fieldset className="grid gap-1">
              <legend className="chalk-ann-heading pb-1">Who can draw</legend>
              {policies.map(({ value, label }) => (
                <label key={value} className="chalk-ann-choice">
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
              <p className="chalk-ann-heading">Requests to draw</p>
              <ul>
                {otherRequests.map((request) => {
                  const person = people.find((entry) => request.participant_id === entry.id);
                  return (
                    <li key={request.request_id} className="chalk-ann-person">
                      <span className="chalk-ann-person-name">
                        <bdi>{person?.name ?? "Participant"}</bdi>
                      </span>
                      <div className="chalk-ann-person-actions">
                        <button type="button" className="chalk-ann-small" data-tone="solid" aria-label={`Allow ${person?.name ?? "participant"} to draw`} onClick={() => command({ kind: "decide_draw", request_id: request.request_id, allow: true })}>
                          Allow
                        </button>
                        <button type="button" className="chalk-ann-small" aria-label={`Decline request from ${person?.name ?? "participant"}`} onClick={() => command({ kind: "decide_draw", request_id: request.request_id, allow: false })}>
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
    </>
  );
}

function DrawAccessPrompt({ state, actorId, ownRequest, command }: { readonly state: ScreenAnnotationState; readonly actorId: string; readonly ownRequest: boolean; readonly command: (command: ScreenAnnotationCommand) => void }) {
  const { access, paused } = state;
  const policy = access.draw_policy;
  const isSharer = actorId === state.layer.sharer_id;
  const cannotDraw = !canDraw(state, actorId);
  const blockedLabel = paused && !isSharer ? "Marks are paused" : policy === "hosts" ? "Only hosts can draw" : "Drawing isn’t available";
  if (!cannotDraw) return null;
  return !access.can_draw && policy !== "hosts" && (!paused || isSharer) ? (
    <button type="button" className="chalk-ann-btn" data-tone={ownRequest ? undefined : "primary"} disabled={ownRequest} onClick={() => command({ kind: "request_draw" })}>
      <StageIcon name="hand" size={15} />
      <span className="chalk-ann-label">{ownRequest ? "Request sent" : "Raise hand to draw"}</span>
    </button>
  ) : (
    <span role="status" className="chalk-ann-status">
      {blockedLabel}
    </span>
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
    <ul aria-label="Drawing permissions and marks by person">
      {entries.map((person) => {
        const contributor = contributors.get(person.id);
        const grant = grants?.find((entry) => entry.participantId === person.id);
        const allowed = grant?.canDraw ?? (policy === "everyone" && person.roleCanDraw);
        const canSetGrant = canManage && people.includes(person) && (policy === "everyone" || !person.managesPolicy);
        return (
          <li key={person.id} className="chalk-ann-person">
            <span className="chalk-ann-person-name">
              {contributor ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: contributor.color }} /> : null}
              <bdi>{person.name}</bdi>
              {contributor ? (
                <span>
                  · {contributor.count} {contributor.count === 1 ? "mark" : "marks"}
                </span>
              ) : null}
            </span>
            <span className="chalk-ann-person-actions">
              {canSetGrant ? (
                <label className="chalk-ann-check">
                  <input type="checkbox" aria-label={`Let ${person.name} draw`} checked={allowed} onChange={(event) => command({ kind: "set_draw_permission", participant_id: person.id, allow: event.target.checked })} />
                  Can draw
                </label>
              ) : null}
              {contributor && state.access.can_moderate ? (
                <button type="button" className="chalk-ann-small" aria-label={`Clear marks by ${person.name}`} onClick={() => command({ kind: "clear", scope: { kind: "participant", participant_id: person.id } })}>
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
