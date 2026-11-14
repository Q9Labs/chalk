import { ChalkMenuPrimitive as Menu } from "../chalk-ui";
import type React from "react";
import { useRef } from "react";
import { ChalkMenuItem } from "../chalk-ui";

type LeaveButtonProps = React.ComponentPropsWithRef<"button">;
export interface LeaveMenuProps {
  readonly onLeave?: () => void;
  readonly onEndForEveryone?: () => void;
  readonly renderButton: (props: LeaveButtonProps) => React.ReactElement;
}
/** Two short rows, so the menu ends at Leave's end and stays narrow instead of reaching across the dock and the notices. */
export function LeaveMenu({ onLeave, onEndForEveryone, renderButton }: LeaveMenuProps): React.JSX.Element {
  const container = useRef<HTMLElement>(null);
  if (!onEndForEveryone) return renderButton({ onClick: onLeave });
  return (
    <span
      ref={(element) => {
        container.current = element?.closest<HTMLElement>("[data-chalk]") ?? element;
      }}
      style={{ display: "contents" }}
    >
      <Menu.Root>
        <Menu.Trigger render={renderButton({})} />
        <Menu.Portal container={container}>
          <Menu.Positioner side="top" align="end" sideOffset={8} collisionPadding={8} className="chalk-menu-positioner">
            <Menu.Popup data-part="menu" className="chalk-menu chalk-shell-leave-menu">
              <ChalkMenuItem onClick={onLeave}>Leave call</ChalkMenuItem>
              <Menu.Item className="chalk-menu-item chalk-shell-danger" onClick={onEndForEveryone}>
                End call for everyone
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}
