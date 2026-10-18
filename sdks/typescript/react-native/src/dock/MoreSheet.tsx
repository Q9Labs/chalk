import type { RefObject } from "react";
import type { View } from "react-native";
import { usePreferences } from "../frame/preferences";
import { BottomSheet } from "../primitives/BottomSheet";
import { SegmentedControl } from "../primitives/SegmentedControl";
import { SheetGroup, SheetRow } from "../primitives/SheetGroup";
import { Switch } from "../primitives/Switch";
import type { ColorScheme } from "../theme/tokens";

export type MoreSheetProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenPeople: () => void;
  readonly returnFocusRef?: RefObject<View | null>;
};

const SCHEMES = [
  { value: "dark", label: "Dark", testID: "more.appearance.dark" },
  { value: "light", label: "Light", testID: "more.appearance.light" },
] as const;

/**
 * More (owned by the dock and chrome lane). This minimal version reaches People and holds the
 * appearance and sound choices until the call details sheet takes them.
 */
export function MoreSheet({ open, onClose, onOpenPeople, returnFocusRef }: MoreSheetProps): React.JSX.Element {
  const preferences = usePreferences();
  return (
    <BottomSheet accessibilityLabel="More options" onClose={onClose} open={open} returnFocusRef={returnFocusRef} testID="sheet.more">
      <SheetGroup>
        <SheetRow icon="users" label="People" onPress={onOpenPeople} testID="more.people" />
        <SheetRow end={<SegmentedControl<ColorScheme> accessibilityLabel="Appearance" onChange={preferences.setColorScheme} options={SCHEMES} testID="more.appearance" value={preferences.colorScheme} />} icon="moon" label="Appearance" />
        <SheetRow end={<Switch accessibilityLabel="Sounds" onValueChange={preferences.setSoundsEnabled} testID="more.sounds" value={preferences.soundsEnabled} />} icon="vol" label="Sounds" />
      </SheetGroup>
    </BottomSheet>
  );
}
