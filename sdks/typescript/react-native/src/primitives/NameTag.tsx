import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { Icon } from "../icons/Icon";
import { fixed, fontFamilies, type } from "../theme/tokens";
import { ChalkText } from "./ChalkText";

export type NameTagProps = {
  readonly name: string;
  readonly muted?: boolean;
  readonly pinned?: boolean;
  /** Raised hand; `handOrder` shows the place in the queue when more than one hand is up. */
  readonly handRaised?: boolean;
  readonly handOrder?: number;
  readonly testID?: string;
};

/** The mockup's name tag (`.tag`): bottom-left of a tile, white on the dark overlay in both themes. */
export const NameTag = memo(function NameTag({ name, muted = false, pinned = false, handRaised = false, handOrder, testID }: NameTagProps): React.JSX.Element {
  return (
    <View pointerEvents="none" style={styles.slot}>
      <View style={styles.tag} testID={testID}>
        {pinned ? <Icon color={fixed.overlayText} name="pin" size={14} /> : null}
        <ChalkText color={fixed.overlayText} numberOfLines={1} style={styles.name} variant="label">
          {name}
        </ChalkText>
        {muted ? <Icon color={fixed.overlayDanger} name="micOff" size={14} /> : null}
        {handRaised ? (
          <View style={styles.hand}>
            <Icon color={fixed.overlayWarning} name="hand" size={14} />
            {handOrder !== undefined ? (
              <ChalkText color={fixed.overlayWarning} style={styles.order} tabular>
                {handOrder}
              </ChalkText>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  // `.tag`: 8 pt from the bottom-left corner and never wider than the tile less 16 pt.
  slot: { position: "absolute", left: 8, right: 8, bottom: 8, flexDirection: "row", zIndex: 2 },
  tag: { flexShrink: 1, height: 24, paddingHorizontal: 8, borderRadius: 6, backgroundColor: fixed.overlay, flexDirection: "row", alignItems: "center", gap: 5 },
  name: { flexShrink: 1 },
  hand: { flexDirection: "row", alignItems: "center", gap: 2 },
  order: { ...type.caption, fontFamily: fontFamilies[700] },
});
