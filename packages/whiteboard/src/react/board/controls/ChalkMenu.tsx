import { Menu } from "@base-ui/react/menu";
export { Menu as ChalkMenuPrimitive };
import { useRef, type ReactElement, type ReactNode } from "react";
import { MenuCheck } from "./MenuCheck";

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
            <Menu.Popup data-part="menu" className={["chalk-menu", className].filter(Boolean).join(" ")} style={{ maxHeight: "var(--available-height)", maxWidth: "var(--available-width)", overflowY: "auto", overscrollBehavior: "contain" }}>
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
      {checked !== undefined ? <MenuCheck on={checked} /> : null}
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
