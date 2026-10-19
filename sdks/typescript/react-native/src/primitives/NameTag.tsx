import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { useMeasuredRef } from "../frame/measurement";
import { Icon, type IconName } from "../icons/Icon";
import { fixed, fontFamilies, type } from "../theme/tokens";
import { ChalkText } from "./ChalkText";

export type NameTagProps = {
  readonly name: string;
  readonly muted?: boolean;
  readonly pinned?: boolean;
  /** A leading icon for a tile that isn't a person, such as `share` on a shared screen or `pen` on the board. */
  readonly icon?: IconName;
  /** Raised hand; `handOrder` shows the place in the queue when more than one hand is up. */
  readonly handRaised?: boolean;
  readonly handOrder?: number;
  readonly testID?: string;
};

/** The mockup's name tag (`.tag`): bottom-left of a tile, white on the dark overlay in both themes. */
export const NameTag = memo(function NameTag({ name, muted = false, pinned = false, icon, handRaised = false, handOrder, testID }: NameTagProps): React.JSX.Element {
  const tagRef = useMeasuredRef<View>(testID, styles.tag);
  return (
    <View pointerEvents="none" style={styles.slot}>
      <View ref={tagRef} style={styles.tag} testID={testID}>
        {pinned ? <Icon color={fixed.overlayText} name="pin" size={14} /> : null}
        {icon ? <Icon color={fixed.overlayText} name={icon} size={14} /> : null}
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

const INSET = 8;
const HEIGHT = 24;

/** The strip at the bottom of a tile that the name tag can cover, so tile content can keep clear of it. */
export const nameTagZone = INSET + HEIGHT;

const styles = StyleSheet.create({
  // `.tag`: 8 pt from the bottom-left corner and never wider than the tile less 16 pt.
  slot: { position: "absolute", left: INSET, right: INSET, bottom: INSET, flexDirection: "row", zIndex: 2 },
  tag: { flexShrink: 1, height: HEIGHT, paddingHorizontal: 8, borderRadius: 6, backgroundColor: fixed.overlay, flexDirection: "row", alignItems: "center", gap: 5 },
  name: { flexShrink: 1 },
  hand: { flexDirection: "row", alignItems: "center", gap: 2 },
  order: { ...type.caption, fontFamily: fontFamilies[700] },
});
