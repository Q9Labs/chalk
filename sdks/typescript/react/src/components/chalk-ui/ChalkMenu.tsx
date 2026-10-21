import { Menu } from "@base-ui/react/menu";
import { useRef, type ReactElement, type ReactNode } from "react";
import { cn } from "../../utils/cn";
export interface ChalkMenuProps {
  readonly trigger: ReactElement;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
  readonly side?: "top" | "bottom";
  readonly className?: string;
}
export function ChalkMenu({ trigger, children, side = "bottom", className, onOpenChange }: ChalkMenuProps) {
  const container = useRef<HTMLElement>(null);
  return (
    <span
      ref={(element) => {
        container.current = element?.closest<HTMLElement>("[data-chalk]") ?? element;
      }}
      style={{ display: "contents" }}
    >
      <Menu.Root onOpenChange={onOpenChange}>
        <Menu.Trigger render={trigger} />
        <Menu.Portal container={container}>
          <Menu.Positioner side={side} align={side === "top" ? "center" : "end"} sideOffset={side === "top" ? 10 : 6} collisionPadding={8} className="chalk-menu-positioner">
            <Menu.Popup data-part="menu" className={cn("chalk-menu", className)}>
              {children}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}
export interface ChalkMenuItemProps {
  readonly children: ReactNode;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly closeOnClick?: boolean;
}
export function ChalkMenuItem({ children, checked, disabled, onClick, closeOnClick }: ChalkMenuItemProps) {
  const content = (
    <>
      {checked !== undefined ? (
        <span data-part="menu-check" className="chalk-menu-check" aria-hidden="true">
          {checked ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : null}
        </span>
      ) : null}
      {children}
    </>
  );
  if (checked !== undefined)
    return (
      <Menu.Item data-part="menu-item" className="chalk-menu-item" role="menuitemradio" aria-checked={checked} disabled={disabled} onClick={onClick} closeOnClick={closeOnClick}>
        {content}
      </Menu.Item>
    );
  return (
    <Menu.Item data-part="menu-item" className="chalk-menu-item" disabled={disabled} onClick={onClick} closeOnClick={closeOnClick}>
      {content}
    </Menu.Item>
  );
}
export function ChalkMenuLabel({ children }: { readonly children: ReactNode }) {
  return (
    <div data-part="menu-label" className="chalk-menu-label">
      {children}
    </div>
  );
}
