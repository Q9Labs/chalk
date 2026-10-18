import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { useIsMobile } from "../../internal/useMediaQuery";
import { ChalkSheet } from "../chalk-ui";
import type { DrawerState } from "../space-view/useDrawerPresence";

export interface CallCardProps {
  readonly state: DrawerState;
  readonly onClose?: () => void;
  readonly interactive?: boolean;
  readonly children: ReactNode;
}

/**
 * The inset card for desktop panels and the focus-trapped bottom sheet on phones. Escape closes it and focus returns to
 * where it came from. Panels keep their own landmarks, so the drawer itself carries no role.
 */
export function CallCard({ state, onClose, interactive = true, children }: CallCardProps) {
  const phone = useIsMobile();
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
        {children}
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
          {children}
        </div>
      </div>
    </>
  );
}
