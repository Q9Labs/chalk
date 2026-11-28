import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { firstName } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationPresence, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";
import { usePhoneCall } from "../../internal/call-width";
import { ChalkMenu, ChalkMenuPrimitive as Menu, ChalkSpinner } from "../chalk-ui";
import { StageIcon } from "../stage/StageIcon";
import { canDraw, visibleMarks } from "./model";

export interface AnnotationPerson {
  readonly id: string;
  readonly name: string;
  readonly roleCanDraw: boolean;
  readonly managesPolicy: boolean;
}

type DrawPolicy = ScreenAnnotationState["access"]["draw_policy"];

/** Ask first is the wire policy "picked": people request, and the sharer grants each request. */
export const policies = [
  { value: "everyone", label: "Everyone" },
  { value: "picked", label: "Ask first" },
  { value: "hosts", label: "Only hosts" },
] satisfies readonly { value: DrawPolicy; label: string }[];

export const policyLabel = (policy: DrawPolicy): string => policies.find((entry) => entry.value === policy)?.label ?? "Everyone";

/** Re-render when the earliest pending draw request expires, since Sync sends no frame for it. */
function useLiveRequests(client: ScreenAnnotationClient, state: ScreenAnnotationState) {
  const [, tick] = useState(0);
  const requests = state.access.requests.filter((request) => request.expires_at_ms > client.serverNowMs());
  const nextExpiry = requests.reduce((next, request) => Math.min(next, request.expires_at_ms), Infinity);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [timer] Hide expired moderation requests without relying on a Sync expiry frame.
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => tick((value) => value + 1), Math.max(1, nextExpiry - client.serverNowMs() + 1));
    return () => clearTimeout(timer);
  }, [client, nextExpiry]);
  return requests;
}

/** The viewer's single entry to drawing, in the share header: Draw, Ask to draw, or the pending ask. Nothing when hosts only. */
export function DrawEntry({ client, state, actorId, sharerName, onDraw, onRequest }: { readonly client: ScreenAnnotationClient; readonly state: ScreenAnnotationState; readonly actorId: string; readonly sharerName: string; readonly onDraw: () => void; readonly onRequest: () => void }) {
  const requests = useLiveRequests(client, state);
  const { access, paused } = state;
  if (canDraw(state, actorId)) {
    return (
      <button type="button" className="chalk-ann-draw" data-tone="solid" onClick={onDraw}>
        <StageIcon name="pen" size={18} />
        Draw
      </button>
    );
  }
  if (paused) {
    return (
      <span role="status" className="chalk-ann-status chalk-ann-draw" data-quiet="">
        Marks are paused
      </span>
    );
  }
  if (access.draw_policy !== "picked") return null;
  if (requests.some((request) => request.participant_id === actorId)) {
    return (
      <span role="status" className="chalk-ann-status chalk-ann-draw" data-quiet="">
        <ChalkSpinner label="Waiting for an answer" className="size-4 border-[var(--chalk-line-strong)] border-t-[var(--chalk-text)]" />
        Asked {firstName(sharerName)}
      </span>
    );
  }
  return (
    <button type="button" className="chalk-ann-draw" onClick={onRequest}>
      <StageIcon name="hand" size={18} />
      Ask to draw
    </button>
  );
}

/** The sharer's "Who can draw" pill and its menu. */
export function WhoCanDrawMenu({ state, command }: { readonly state: ScreenAnnotationState; readonly command: (command: ScreenAnnotationCommand) => void }) {
  const policy = state.access.draw_policy;
  const phone = usePhoneCall();
  return (
    <ChalkMenu
      side="bottom"
      trigger={
        <button type="button" className="chalk-ann-pill" aria-label={`Who can draw: ${policyLabel(policy)}`}>
          <HugeiconsIcon icon={UserGroupIcon} size={16} aria-hidden="true" />
          {phone ? null : <span>Who can draw: {policyLabel(policy)}</span>}
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} aria-hidden="true" />
        </button>
      }
    >
      <div className="chalk-menu-label">Who can draw</div>
      {policies.map(({ value, label }) => (
        <Menu.Item key={value} className="chalk-menu-item" role="menuitemradio" aria-checked={policy === value} onClick={() => policy !== value && command({ kind: "set_policy", policy: value })}>
          <span>{label}</span>
          <span className="chalk-menu-check" aria-hidden="true">
            {policy === value ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : null}
          </span>
        </Menu.Item>
      ))}
      <div className="chalk-menu-label">Applies to the board too</div>
      <Menu.Separator className="chalk-shell-menu-separator" />
      <Menu.CheckboxItem className="chalk-menu-item" checked={state.paused} onCheckedChange={(paused) => command({ kind: "pause", paused })} closeOnClick={false}>
        <span>Pause drawing</span>
        <span className="chalk-shell-menu-switch" aria-hidden="true">
          <span className="chalk-switch" aria-checked={state.paused}>
            <span />
          </span>
        </span>
      </Menu.CheckboxItem>
      <Menu.Item className="chalk-menu-item" style={{ color: "var(--chalk-danger-text)" }} onClick={() => command({ kind: "clear", scope: { kind: "all" } })}>
        <HugeiconsIcon icon={Delete02Icon} size={18} aria-hidden="true" />
        Clear all marks
      </Menu.Item>
    </ChalkMenu>
  );
}

function drawerOf(state: ScreenAnnotationState, presence: readonly ScreenAnnotationPresence[], actorId: string, now: number): string | undefined {
  if (state.paused) return undefined;
  const live = presence.find((peer) => peer.author.participant_id !== actorId && peer.expires_at_ms > now && (peer.draft || peer.cursor?.tool === "pointer"));
  return (live ?? visibleMarks(state, now).find((mark) => mark.author.participant_id !== actorId))?.author.display_name;
}

/** The sharer's header line beside the title: a request to allow, otherwise who is drawing and whether Chalk Helper shows the marks. Renders nothing when neither applies. */
export function SharerTitle({
  client,
  state,
  presence,
  actorId,
  people,
  helperShowing,
  command,
}: {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly actorId: string;
  readonly people: readonly AnnotationPerson[];
  readonly helperShowing: boolean;
  readonly command: (command: ScreenAnnotationCommand) => void;
}) {
  const requests = useLiveRequests(client, state);
  const request = state.access.draw_policy === "picked" ? requests.find((entry) => entry.participant_id !== actorId) : undefined;
  if (request) {
    const name = firstName(people.find((person) => person.id === request.participant_id)?.name ?? "Someone");
    return (
      <div role="status" data-part="sharer-title" data-request="" className="chalk-ann-title">
        <StageIcon name="hand" size={18} />
        <span>
          <b>{name}</b> wants to draw
        </span>
        <span className="flex-1" />
        <button type="button" className="chalk-ann-pill" onClick={() => command({ kind: "decide_draw", request_id: request.request_id, allow: false })}>
          Not now
        </button>
        <button type="button" className="chalk-ann-pill" data-tone="solid" aria-label={`Allow ${name} to draw`} onClick={() => command({ kind: "decide_draw", request_id: request.request_id, allow: true })}>
          Allow
        </button>
      </div>
    );
  }
  const drawer = drawerOf(state, presence, actorId, client.serverNowMs());
  if (!drawer && !helperShowing) return null;
  return (
    <div role="status" data-part="sharer-title" className="chalk-ann-title">
      {helperShowing ? (
        <span className="chalk-ann-live">
          <i aria-hidden="true" />
          Marks on your screen
        </span>
      ) : null}
      {drawer ? <span className="chalk-ann-muted">{firstName(drawer)} is drawing</span> : null}
    </div>
  );
}
