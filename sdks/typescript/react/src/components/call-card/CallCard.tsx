import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { CallCardStyles } from "./CallCardStyles";
import { cn } from "../../utils/cn";
import { useIsMobile } from "../../internal/useMediaQuery";
import { ChalkSheet } from "../chalk-ui";
import type { DrawerState } from "../space-view/useDrawerPresence";

export interface CallCardProps {
  readonly state: DrawerState;
  readonly panel?: "participants" | "chat" | "admission" | null;
  readonly onPanelChange?: (panel: "participants" | "chat") => void;
  readonly peopleCount?: number;
  readonly chatEnabled?: boolean;
  readonly participantsEnabled?: boolean;
  readonly onClose?: () => void;
  readonly interactive?: boolean;
  readonly children: ReactNode;
}

/**
 * The inset card for desktop panels and the focus-trapped bottom sheet on phones. Escape closes it and focus returns to
 * where it came from. Panels keep their own landmarks, so the drawer itself carries no role.
 */
export function CallCard({ state, onClose, interactive = true, children, panel, onPanelChange, peopleCount, chatEnabled = true, participantsEnabled = true }: CallCardProps) {
  const phone = useIsMobile();
  const id = useId();
  const tabs: ("participants" | "chat")[] = [];
  if (participantsEnabled) tabs.push("participants");
  if (chatEnabled) tabs.push("chat");
  const selected = panel === "chat" ? "chat" : "participants";
  const drawerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!interactive || state !== "open") return;
    const drawer = drawerRef.current;
    if (!drawer || drawer.contains(document.activeElement)) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.focus({ preventScroll: true });
  }, [interactive, state]);

  useEffect(() => {
    if (!interactive || state !== "closing") return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [interactive, state]);

  const content = (
    <>
      <CallCardStyles />
      {onPanelChange ? (
        <div
          className="call-card-tabs"
          role="tablist"
          aria-label="Call panels"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || tabs.length < 2) return;
            event.preventDefault();
            const next = event.key === "Home" ? "participants" : event.key === "End" ? "chat" : panel === "chat" ? "participants" : "chat";
            onPanelChange(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-card-tab="${next}"]`)?.focus();
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab}
              id={`${id}-${tab}`}
              aria-controls={`${id}-content`}
              type="button"
              className="call-card-tab"
              data-card-tab={tab}
              role="tab"
              aria-selected={tab === "participants" ? panel !== "chat" : panel === "chat"}
              tabIndex={(tab === "participants" ? panel !== "chat" : panel === "chat") ? 0 : -1}
              onClick={() => onPanelChange(tab)}
            >
              {tab === "participants" ? (
                <>
                  People <span className="call-card-count">{peopleCount}</span>
                </>
              ) : (
                "Chat"
              )}
            </button>
          ))}
          <button type="button" className="call-card-close" aria-label="Close panel" onClick={onClose}>
            ×
          </button>
        </div>
      ) : null}
      <div id={`${id}-content`} role={onPanelChange ? "tabpanel" : undefined} aria-labelledby={onPanelChange ? `${id}-${selected}` : undefined} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </>
  );

  if (phone && interactive)
    return (
      <ChalkSheet
        variant="panel"
        open={state === "open"}
        onOpenChange={(open) => {
          if (!open) onClose?.();
        }}
        title="People and Chat"
      >
        {content}
      </ChalkSheet>
    );
  if (state === "closed") return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose?.();
  };

  return (
    <>
      <div ref={drawerRef} data-part="panel-card" tabIndex={interactive ? -1 : undefined} data-state={state} data-chalk-drawer onKeyDown={interactive ? handleKeyDown : undefined} aria-disabled={interactive ? undefined : true} className="chalk-drawer min-h-0 outline-none focus-visible:outline-none">
        <div data-part="panel-content" className={cn("chalk-drawer-content flex min-h-0 flex-col overflow-hidden bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)]")}>
          {content}
        </div>
      </div>
    </>
  );
}
