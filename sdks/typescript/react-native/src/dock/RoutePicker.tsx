import type { RefObject } from "react";
import { Platform, type View } from "react-native";
import { Icon } from "../icons/Icon";
import { BottomSheet } from "../primitives/BottomSheet";
import { Menu, MenuItem } from "../primitives/Menu";
import { SheetGroup, SheetRow } from "../primitives/SheetGroup";
import { useTheme } from "../theme/theme";
import { routeIcons, routeName, type AudioOutput } from "./audio-route";

export type RoutePickerProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (id: string) => void;
  readonly output: AudioOutput;
  readonly anchorRef: RefObject<View | null>;
};

/**
 * The audio output choice once a headset joins the earpiece and the speaker: a menu next to the
 * button on iOS, where the mockup draws the system route menu, and a sheet on Android.
 */
export function RoutePicker({ open, onClose, onSelect, output, anchorRef }: RoutePickerProps): React.JSX.Element | null {
  const { colors } = useTheme();
  if (Platform.OS === "ios") {
    return (
      <Menu accessibilityLabel="Audio output" anchorRef={anchorRef} onClose={onClose} open={open} testID="menu.route">
        {output.routes.map((route) => (
          <MenuItem checked={route.id === output.selected} icon={routeIcons[route.kind]} key={route.id} label={routeName(route)} onPress={() => onSelect(route.id)} testID={`menu.route.${route.kind}`} />
        ))}
      </Menu>
    );
  }
  return (
    <BottomSheet accessibilityLabel="Audio output" onClose={onClose} open={open} returnFocusRef={anchorRef} testID="sheet.route" title="Audio output">
      <SheetGroup>
        {output.routes.map((route) => (
          <SheetRow end={route.id === output.selected ? <Icon color={colors.text} name="check" /> : null} icon={routeIcons[route.kind]} key={route.id} label={routeName(route)} onPress={() => onSelect(route.id)} testID={`sheet.route.${route.kind}`} />
        ))}
      </SheetGroup>
    </BottomSheet>
  );
}
