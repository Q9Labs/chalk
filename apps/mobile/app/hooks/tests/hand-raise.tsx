import { View, Text, StyleSheet } from 'react-native';
import { useHandRaise, useParticipants } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function HandRaiseTest() {
  const { isHandRaised, raiseHand, lowerHand, toggleHandRaise } = useHandRaise();
  const { participants } = useParticipants();

  const raisedHands = participants.filter((p) => p.handRaised);

  return (
    <TestScreen
      title="useHandRaise"
      description="Raise or lower your hand to get attention during a call."
      controls={
        <View style={styles.row}>
          <TestButton
            title="Raise Hand"
            onPress={raiseHand}
            disabled={isHandRaised}
          />
          <TestButton
            title="Lower Hand"
            onPress={lowerHand}
            variant="danger"
            disabled={!isHandRaised}
          />
          <TestButton
            title="Toggle"
            onPress={toggleHandRaise}
            variant="secondary"
          />
        </View>
      }
      state={
        <>
          <StatusBadge label="Hand Raised" value={isHandRaised} />
          <StatusBadge label="Total Raised" value={raisedHands.length} />

          {raisedHands.length > 0 && (
            <View style={styles.raisedList}>
              <Text style={styles.listTitle}>Raised Hands:</Text>
              {raisedHands.map((p) => (
                <Text key={p.id} style={styles.participantName}>
                  {p.displayName || 'Unknown'} {p.isLocal && '(You)'}
                </Text>
              ))}
            </View>
          )}
        </>
      }
      debugData={{ isHandRaised, raisedHands: raisedHands.map((p) => p.id) }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  raisedList: {
    marginTop: 16,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
  },
  listTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
  },
  participantName: {
    fontSize: 15,
    color: '#333',
    paddingVertical: 4,
  },
});
