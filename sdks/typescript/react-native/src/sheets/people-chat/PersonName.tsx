import { StyleSheet, View } from "react-native";
import { AIBadge } from "../../primitives/AIBadge";
import { ChalkText } from "../../primitives/ChalkText";
import { space } from "../../theme/tokens";

type PersonNameProps = {
  readonly name: string;
  readonly participantId: string;
  readonly isSelf: boolean;
  readonly agent: boolean;
  readonly badgeTestID: string;
  readonly host?: boolean;
  /** What a screen reader says for the name, with the person's status. */
  readonly label?: string;
  /** What they are on, such as "iPhone" or "Mac · 2 devices"; absent when Sync sent nothing. */
  readonly device?: string;
  /** What the person or AI participant says it is for, shown as the last line. */
  readonly description?: string;
};

/** A People row's name with its "(You)" and "Host" marks and the AI badge, then the device and the description on lines under it. */
export function PersonName({ name, participantId, isSelf, agent, badgeTestID, host = false, label, device, description }: PersonNameProps): React.JSX.Element {
  return (
    <View style={styles.who}>
      <View style={styles.nameLine}>
        <ChalkText accessibilityLabel={device && label ? `${label}, ${device}` : label} numberOfLines={1} style={styles.shrink} variant="bodyMedium">
          {name}
          {isSelf ? (
            <ChalkText tone="textMuted" variant="meta">
              {"  (You)"}
            </ChalkText>
          ) : null}
          {host ? (
            <ChalkText tone="textMuted" variant="meta">
              {"  Host"}
            </ChalkText>
          ) : null}
        </ChalkText>
        {agent ? <AIBadge testID={badgeTestID} /> : null}
      </View>
      {device ? (
        <ChalkText numberOfLines={1} style={styles.line} tone="textMuted" variant="meta" testID={`people.device.${participantId}`}>
          {device}
        </ChalkText>
      ) : null}
      {description ? (
        <ChalkText numberOfLines={1} style={styles.line} testID={`people.description.${participantId}`} tone="textMuted" variant="meta">
          {description}
        </ChalkText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  who: { flex: 1 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: space["1-5"] },
  shrink: { flexShrink: 1 },
  line: { marginTop: space["0-5"] },
});
