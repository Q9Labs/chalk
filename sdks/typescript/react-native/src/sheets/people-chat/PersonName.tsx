import type { Participant } from "@q9labsai/chalk-client";
import { StyleSheet, View } from "react-native";
import { AIBadge } from "../../primitives/AIBadge";
import { ChalkText } from "../../primitives/ChalkText";
import { space } from "../../theme/tokens";

type PersonNameProps = {
  readonly participant: Participant;
  readonly isSelf: boolean;
  readonly host?: boolean;
  readonly accessibilityLabel?: string;
  readonly badgeTestID: string;
};

function NameText({ participant, isSelf, host = false, accessibilityLabel, style }: Omit<PersonNameProps, "badgeTestID"> & { readonly style: object }): React.JSX.Element {
  return (
    <ChalkText accessibilityLabel={accessibilityLabel} numberOfLines={1} style={style} variant="bodyMedium">
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
  );
}

/** A person's name with the (You) and Host marks and the AI badge, as one flexible row item. */
export function PersonName(props: PersonNameProps): React.JSX.Element {
  return (
    <>
      <NameText {...props} style={styles.name} />
      {props.participant.identityKind === "agent" ? <AIBadge testID={props.badgeTestID} /> : null}
    </>
  );
}

/** A person's name line with the AI badge and, when they have one, their description underneath. */
export function PersonDetails(props: PersonNameProps): React.JSX.Element {
  const { participant, badgeTestID } = props;
  return (
    <View style={styles.who}>
      <View style={styles.nameLine}>
        <NameText {...props} style={styles.shrink} />
        {participant.identityKind === "agent" ? <AIBadge testID={badgeTestID} /> : null}
      </View>
      {participant.description ? (
        <ChalkText numberOfLines={1} style={styles.description} testID={`people.description.${participant.participantId}`} tone="textMuted" variant="meta">
          {participant.description}
        </ChalkText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  name: { flex: 1 },
  who: { flex: 1 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: space["1-5"] },
  shrink: { flexShrink: 1 },
  description: { marginTop: space["0-5"] },
});
