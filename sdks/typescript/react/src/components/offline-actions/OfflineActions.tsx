import type { OfflineAction } from "@q9labsai/chalk-client";
import React, { useEffect, useRef, useState } from "react";

import { useConnection, useOffline, useSpaceClient } from "../../bindings/hooks";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import { WifiOffIcon } from "../../utils/icons";
import { ChalkBackdrop, ChalkButton, ChalkCheckbox, ChalkDialogPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { useOfflineActionsPolicy } from "./offline-actions-policy";

const ACTION_LABELS = { hand_raise: "Raise hand", hand_lower: "Lower hand" } as const;

function actionLabel(action: OfflineAction): string {
  return action.kind === "chat_message" ? `Message: ${action.text ?? ""}` : ACTION_LABELS[action.kind];
}

function ageLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

export function offlineNoticeText(pendingCount: number): string {
  if (pendingCount === 0) return "You're offline. Reconnecting…";
  return `You're offline. ${pendingCount === 1 ? "1 action" : `${pendingCount} actions`} will send when you're back.`;
}

/** Calm, non-blocking notice shown while the connection recovers. */
export function OfflineNotice({ pendingCount }: { readonly pendingCount: number }): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-4">
      <p role="status" className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-3.5 py-2 text-sm text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)]">
        <WifiOffIcon size={16} className="shrink-0 text-[var(--chalk-app-text-muted)]" />
        <span>{offlineNoticeText(pendingCount)}</span>
      </p>
    </div>
  );
}

/** Asks whether to send or discard the actions that waited while the user was offline. */
export function OfflineDecisionDialog({ actions, now, onSend, onDiscard }: { readonly actions: readonly OfflineAction[]; readonly now: number; readonly onSend: (remember: boolean) => void; readonly onDiscard: (remember: boolean) => void }): React.JSX.Element {
  const prefersReducedMotion = usePrefersReducedMotion();
  const skin = useSkin();
  const [remember, setRemember] = useState(false);
  const sendRef = useRef<HTMLButtonElement>(null);

  useEffect(() => sendRef.current?.focus(), []);

  return (
    <div className={cn("fixed inset-0 z-[100] flex items-center justify-center p-4", !prefersReducedMotion && "animate-in fade-in duration-200")}>
      <ChalkBackdrop className="!bg-[color-mix(in_srgb,var(--chalk-app-canvas)_65%,transparent)]" />
      <ChalkDialogPanel
        role="dialog"
        aria-modal="true"
        aria-labelledby="offline-actions-title"
        aria-describedby="offline-actions-description"
        className="relative w-full max-w-[440px] !rounded-[14px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] !p-6 shadow-[var(--chalk-app-shadow-sm)]"
      >
        <h2 id="offline-actions-title" className="text-xl font-semibold tracking-[-0.025em] text-[var(--chalk-app-text)]">
          Send your offline actions?
        </h2>
        <p id="offline-actions-description" className="mt-2 text-sm leading-6 text-[var(--chalk-app-text-muted)]">
          You're back online. Some of these may be out of date.
        </p>
        <ul className="mt-4 max-h-48 divide-y divide-[var(--chalk-app-line)] overflow-y-auto rounded-[10px] border border-[var(--chalk-app-line)]">
          {actions.map((action) => (
            <li key={action.id} className="flex items-baseline justify-between gap-4 px-3 py-2 text-sm text-[var(--chalk-app-text)]">
              <span className="min-w-0 truncate">{actionLabel(action)}</span>
              <span className="shrink-0 text-xs text-[var(--chalk-app-text-muted)]">{ageLabel(now - action.queuedAt)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <ChalkCheckbox checked={remember} onChange={(event) => setRemember(event.target.checked)} label="Remember my choice" />
          <p className="mt-1 pl-7 text-xs text-[var(--chalk-app-text-muted)]">You can change this later in Settings.</p>
        </div>
        <div className="mt-6 flex gap-3">
          <ChalkButton variant="outline" className="!h-11 flex-1" onClick={() => onDiscard(remember)}>
            Discard actions
          </ChalkButton>
          <ChalkButton ref={sendRef} variant="solid" tone="accent" className={cn("!h-11 flex-1", skin === "classic" && "!text-[var(--chalk-accent-text,#fff)]")} onClick={() => onSend(remember)}>
            Send actions
          </ChalkButton>
        </div>
      </ChalkDialogPanel>
    </div>
  );
}

/** Applies the remembered choice to the client, shows the offline notice, and asks when there is no remembered choice. */
export function OfflineActions(): React.JSX.Element | null {
  const client = useSpaceClient();
  const connection = useConnection();
  const offline = useOffline();
  const [policy, setPolicy] = useOfflineActionsPolicy();

  useEffect(() => {
    void client.offline.setPolicy(policy);
  }, [client, policy]);

  const decide = (decision: "send" | "discard", remember: boolean) => {
    if (remember) setPolicy(decision);
    void (decision === "send" ? client.offline.send() : client.offline.discard());
  };

  if (connection.status === "reconnecting") return <OfflineNotice pendingCount={offline.pending.length} />;
  if (offline.decisionNeeded) return <OfflineDecisionDialog actions={offline.pending} now={Date.now()} onSend={(remember) => decide("send", remember)} onDiscard={(remember) => decide("discard", remember)} />;
  if (offline.notice)
    return (
      <p role="status" className="absolute inset-x-0 top-3 z-40 mx-auto w-fit rounded-xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-3.5 py-2 text-sm text-[var(--chalk-app-text)]">
        {offline.notice}
      </p>
    );
  return null;
}
