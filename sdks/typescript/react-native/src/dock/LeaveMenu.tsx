import type { RefObject } from "react";
import type { View } from "react-native";
import { Menu, MenuItem } from "../primitives/Menu";

export type LeaveMenuProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: RefObject<View | null>;
  readonly onLeave: () => void;
  readonly onEnd: () => void;
};

/** A host's Leave button asks whether to leave alone or end the call for everyone. */
export function LeaveMenu({ open, onClose, anchorRef, onLeave, onEnd }: LeaveMenuProps): React.JSX.Element | null {
  return (
    <Menu accessibilityLabel="Leave" anchorRef={anchorRef} onClose={onClose} open={open} testID="menu.leave">
      <MenuItem label="Leave call" onPress={onLeave} testID="menu.leave.leave" />
      <MenuItem danger label="End call for everyone" onPress={onEnd} testID="menu.leave.end" />
    </Menu>
  );
}
