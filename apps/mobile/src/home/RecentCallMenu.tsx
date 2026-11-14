import { announce, Menu, MenuItem } from "@q9labsai/chalk-react-native/ui";
import { setStringAsync } from "expo-clipboard";
import type { RefObject } from "react";
import type { View } from "react-native";
import { shareLink } from "../lib/share";
import type { RecentCall } from "./recent-calls";

export type OpenMenu = { readonly call: RecentCall; readonly anchorRef: RefObject<View | null> };

/** Options for one recent call. `fallbackAnchor` keeps the menu mounted while no call is chosen. */
export function RecentCallMenu({ menu, fallbackAnchor, onClose, onRemove }: { readonly menu: OpenMenu | null; readonly fallbackAnchor: RefObject<View | null>; readonly onClose: () => void; readonly onRemove: (call: RecentCall) => void }): React.JSX.Element {
  return (
    <Menu accessibilityLabel="Call options" anchorRef={menu?.anchorRef ?? fallbackAnchor} onClose={onClose} open={menu !== null} testID="menu.recent">
      {menu ? (
        <>
          <MenuItem
            icon="copy"
            label="Copy link"
            onPress={() => {
              onClose();
              void setStringAsync(menu.call.link).then(() => announce("Link copied"));
            }}
            testID="menu.recent.copy"
          />
          <MenuItem
            icon="iosShare"
            label="Share link"
            onPress={() => {
              onClose();
              shareLink(menu.call.link);
            }}
            testID="menu.recent.share"
          />
          <MenuItem danger icon="trash" label="Remove from recent calls" onPress={() => onRemove(menu.call)} testID="menu.recent.remove" />
        </>
      ) : null}
    </Menu>
  );
}
