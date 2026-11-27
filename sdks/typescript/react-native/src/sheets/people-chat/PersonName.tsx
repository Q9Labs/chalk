import { StyleSheet, View } from "react-native";
import { AIBadge } from "../../primitives/AIBadge";
import { ChalkText } from "../../primitives/ChalkText";

type PersonNameProps = {
  readonly name: string;
  /** What a screen reader says for the name, with the person's status. */
  readonly label: string;
  readonly participantId: string;
  readonly isSelf: boolean;
  readonly host: boolean;
  readonly agent: boolean;
  /** What they are on, such as "iPhone" or "Mac · 2 devices"; absent when Sync sent nothing. */
  readonly device: string | undefined;
};

/** A People row's name with its "(You)" and "Host" marks and the AI badge, and the device on a line under it. */
export function PersonName({ name, label, participantId, isSelf, host, agent, device }: PersonNameProps): React.JSX.Element {
  return (
    <View style={styles.name}>
      <ChalkText accessibilityLabel={device ? `${label}, ${device}` : label} numberOfLines={1} variant="bodyMedium">
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
      {agent ? <AIBadge testID={`people.ai.${participantId}`} /> : null}
      {device ? (
        <ChalkText numberOfLines={1} tone="textMuted" variant="meta" testID={`people.device.${participantId}`}>
          {device}
        </ChalkText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  name: { flex: 1 },
});
