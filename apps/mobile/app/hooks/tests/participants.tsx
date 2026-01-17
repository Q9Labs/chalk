import { View, Text, StyleSheet } from 'react-native';
import { useParticipants } from '@q9labs/chalk-react-native';
import { TestScreen, StatusBadge } from '@/components/test/TestScreen';

export default function ParticipantsTest() {
  const { participants, localParticipant, remoteParticipants } = useParticipants();

  return (
    <TestScreen
      title="useParticipants"
      description="Access participant lists: all participants, local participant, and remote participants."
      state={
        <>
          <StatusBadge label="Total Participants" value={participants.length} />
          <StatusBadge label="Remote Participants" value={remoteParticipants.length} />
          <StatusBadge label="Local ID" value={localParticipant?.id ?? 'N/A'} />

          {participants.length > 0 && (
            <View style={styles.participantList}>
              <Text style={styles.listTitle}>Participant List:</Text>
              {participants.map((p) => (
                <View key={p.id} style={styles.participantItem}>
                  <Text style={styles.participantName}>
                    {p.displayName || 'Unknown'} {p.isLocal && '(You)'}
                  </Text>
                  <Text style={styles.participantId}>{p.id}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      }
      debugData={{ localParticipant, remoteParticipants }}
    />
  );
}

const styles = StyleSheet.create({
  participantList: {
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
  participantItem: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  participantName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#333',
  },
  participantId: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
});
