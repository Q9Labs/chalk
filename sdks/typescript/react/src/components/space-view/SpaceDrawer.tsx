import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { ChalkBackdrop } from "../chalk-ui";
import { useSkin } from "../skin-context";
import type { DrawerState } from "./useDrawerPresence";

export interface SpaceDrawerProps {
  readonly state: DrawerState;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * The right-hand home for the Space's side panels. Below `lg` it is a sheet over the stage with a
 * scrim; from `lg` up it docks beside the stage and pushes it. Escape closes it and focus returns to
 * where it came from. Panels keep their own landmarks, so the drawer itself carries no role.
 */
export function SpaceDrawer({ state, onClose, children }: SpaceDrawerProps) {
  const skin = useSkin();
  const drawerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (state !== "open") return;
    const drawer = drawerRef.current;
    if (!drawer || drawer.contains(document.activeElement)) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.focus({ preventScroll: true });
  }, [state]);

  useEffect(() => {
    if (state !== "closing") return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [state]);

  if (state === "closed") return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  return (
    <>
      <ChalkBackdrop className="chalk-drawer-scrim !bg-[color-mix(in_srgb,var(--chalk-app-canvas)_55%,transparent)]" onClick={onClose} />
      <div ref={drawerRef} tabIndex={-1} data-state={state} data-chalk-drawer onKeyDown={handleKeyDown} className="chalk-drawer min-h-0 outline-none focus-visible:outline-none">
        <div className={cn("chalk-drawer-content chalk-textured-surface flex min-h-0 flex-col overflow-hidden bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)]", skin === "classic" ? "shadow-[var(--chalk-app-shadow-xs)]" : "border border-[var(--chalk-app-line)]")}>{children}</div>
      </div>
    </>
  );
}
