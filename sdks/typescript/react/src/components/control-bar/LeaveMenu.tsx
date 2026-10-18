import { Menu } from "@base-ui/react/menu";
import React, { useRef } from "react";

import { CallEnd01Icon, Logout01Icon } from "../../utils/icons";

type LeaveButtonProps = React.ComponentPropsWithRef<"button">;

export interface LeaveMenuProps {
  readonly onLeave?: () => void;
  /** Set for hosts: the leave button then opens a menu with Leave call and End call for everyone. */
  readonly onEndForEveryone?: () => void;
  readonly renderButton: (props: LeaveButtonProps) => React.ReactElement;
}

const POPUP =
  "z-50 min-w-[220px] origin-[var(--transform-origin)] rounded-[12px] bg-[var(--chalk-app-panel)] p-1.5 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)] ring-1 ring-[var(--chalk-app-line)] outline-none transition-[opacity,transform] duration-150 data-[ending-style]:translate-y-[2px] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-[2px] data-[starting-style]:opacity-0 motion-reduce:transition-none";
const ITEM = "flex h-10 cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 text-sm font-medium outline-none select-none data-[highlighted]:bg-[var(--chalk-app-control-hover)]";

/** A guest's leave button leaves at once; a host's opens a small menu anchored to it. */
export function LeaveMenu({ onLeave, onEndForEveryone, renderButton }: LeaveMenuProps): React.JSX.Element {
  const menuHost = useRef<HTMLSpanElement>(null);
  if (!onEndForEveryone) return renderButton({ onClick: onLeave });
  return (
    <Menu.Root>
      <Menu.Trigger render={(props) => renderButton(props)} />
      <span ref={menuHost} className="pointer-events-none absolute top-0 left-0 h-0 w-0" />
      <Menu.Portal container={menuHost}>
        <Menu.Positioner side="top" align="end" sideOffset={10} className="z-50">
          <Menu.Popup className={POPUP}>
            <Menu.Item className={ITEM} onClick={onLeave}>
              <Logout01Icon size={16} />
              Leave call
            </Menu.Item>
            <Menu.Item className={`${ITEM} text-[var(--chalk-app-danger)]`} onClick={onEndForEveryone}>
              <CallEnd01Icon size={16} />
              End call for everyone
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
