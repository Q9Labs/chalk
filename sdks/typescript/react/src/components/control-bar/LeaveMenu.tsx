import { Menu } from "@base-ui/react/menu";
import type React from "react";
import { ChalkMenu, ChalkMenuItem } from "../chalk-ui";

type LeaveButtonProps = React.ComponentPropsWithRef<"button">;
export interface LeaveMenuProps {
  readonly onLeave?: () => void;
  readonly onEndForEveryone?: () => void;
  readonly renderButton: (props: LeaveButtonProps) => React.ReactElement;
}
export function LeaveMenu({ onLeave, onEndForEveryone, renderButton }: LeaveMenuProps): React.JSX.Element {
  if (!onEndForEveryone) return renderButton({ onClick: onLeave });
  return (
    <ChalkMenu side="top" trigger={renderButton({})}>
      <ChalkMenuItem onClick={onLeave}>Leave call</ChalkMenuItem>
      <Menu.Item className="chalk-menu-item chalk-shell-danger" onClick={onEndForEveryone}>
        End call for everyone
      </Menu.Item>
    </ChalkMenu>
  );
}
