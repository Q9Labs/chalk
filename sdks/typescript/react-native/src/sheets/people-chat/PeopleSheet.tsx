import { FlatList, StyleSheet, View } from "react-native";
import { FaceAvatar } from "../../avatar/FaceAvatar";
import { useParticipants, useSelf } from "../../hooks/space-hooks";
import { BottomSheet } from "../../primitives/BottomSheet";
import { ChalkText } from "../../primitives/ChalkText";

export type PeopleSheetProps = {
  readonly open: boolean;
  readonly onClose: () => void;
};

/**
 * People and Chat (owned by the People and Chat lane). This minimal version lists who is in the
 * call in a 78 % sheet.
 */
export function PeopleSheet({ open, onClose }: PeopleSheetProps): React.JSX.Element {
  const { roster } = useParticipants();
  const self = useSelf();
  return (
    <BottomSheet accessibilityLabel="People" heightRatio={0.78} onClose={onClose} open={open} testID="sheet.people" title={`People ${roster.length}`}>
      <FlatList
        data={roster}
        keyExtractor={(participant) => participant.participantId}
        renderItem={({ item }) => (
          <View accessible style={styles.row} testID={`people.row.${item.participantId}`}>
            <FaceAvatar name={item.displayName} size={32} />
            <ChalkText numberOfLines={1} style={styles.name} variant="bodyMedium">
              {item.participantId === self.participantId ? `${item.displayName} (You)` : item.displayName}
            </ChalkText>
          </View>
        )}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingLeft: 8, paddingRight: 4 },
  name: { flex: 1 },
});
