import { View, StyleSheet } from 'react-native';
import { useInteractions } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

const REACTIONS = ['like', 'love', 'laugh', 'surprise', 'sad', 'angry'] as const;

export default function InteractionsTest() {
  const { activeReactions, sendReaction, clearReaction } = useInteractions();

  return (
    <TestScreen
      title="useInteractions"
      description="Send emoji reactions during a call."
      controls={
        <>
          <View style={styles.reactionGrid}>
            {REACTIONS.map((reaction) => (
              <TestButton
                key={reaction}
                title={reaction}
                onPress={() => sendReaction(reaction)}
                variant="secondary"
              />
            ))}
          </View>
          <TestButton
            title="Clear Reaction"
            onPress={clearReaction}
            variant="danger"
          />
        </>
      }
      state={
        <StatusBadge label="Active Reactions" value={activeReactions.length} />
      }
      debugData={{ activeReactions }}
    />
  );
}

const styles = StyleSheet.create({
  reactionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
