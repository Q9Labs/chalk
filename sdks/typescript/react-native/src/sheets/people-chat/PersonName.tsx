import type { Participant } from "@q9labsai/chalk-client";
import { StyleSheet } from "react-native";
import { AIBadge } from "../../primitives/AIBadge";
import { ChalkText } from "../../primitives/ChalkText";

type PersonNameProps = {
  readonly participant: Participant;
  readonly isSelf: boolean;
  readonly host?: boolean;
  readonly accessibilityLabel?: string;
  readonly badgeTestID: string;
};

/** A person's name in the People tab, with the (You) and Host marks and the AI badge. */
export function PersonName({ participant, isSelf, host = false, accessibilityLabel, badgeTestID }: PersonNameProps): React.JSX.Element {
  return (
    <>
      <ChalkText accessibilityLabel={accessibilityLabel} numberOfLines={1} style={styles.name} variant="bodyMedium">
        {participant.displayName}
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
      {participant.identityKind === "agent" ? <AIBadge testID={badgeTestID} /> : null}
    </>
  );
}

const styles = StyleSheet.create({ name: { flex: 1 } });
