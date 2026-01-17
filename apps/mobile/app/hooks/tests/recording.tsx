import { View, StyleSheet } from 'react-native';
import { useRecording } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function RecordingTest() {
  const {
    isRecording,
    recordingStatus,
    startRecording,
    stopRecording,
    recordings,
  } = useRecording();

  return (
    <TestScreen
      title="useRecording"
      description="Start and stop cloud recordings of the call."
      controls={
        <View style={styles.row}>
          <TestButton
            title="Start Recording"
            onPress={startRecording}
            disabled={isRecording}
          />
          <TestButton
            title="Stop Recording"
            onPress={stopRecording}
            variant="danger"
            disabled={!isRecording}
          />
        </View>
      }
      state={
        <>
          <StatusBadge label="Recording" value={isRecording} />
          <StatusBadge
            label="Status"
            value={recordingStatus ?? 'idle'}
            color={recordingStatus === 'recording' ? 'red' : 'gray'}
          />
          <StatusBadge label="Total Recordings" value={recordings.length} />
        </>
      }
      debugData={{ isRecording, recordingStatus, recordings }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
});
