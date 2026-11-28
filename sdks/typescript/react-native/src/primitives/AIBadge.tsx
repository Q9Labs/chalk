import { memo } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "../theme/theme";

/** The sparkle that marks an admitted AI participant after its name, in the surrounding text colour. */
export const AIBadge = memo(function AIBadge({ testID, color }: { readonly testID?: string; readonly color?: string }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View accessibilityLabel="AI participant" accessibilityRole="image" testID={testID}>
      <Svg fill="none" height={14} stroke={color ?? colors.text} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} viewBox="0 0 16 16" width={14}>
        <Path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L10.5 13l1.5-.5z" />
      </Svg>
    </View>
  );
});
