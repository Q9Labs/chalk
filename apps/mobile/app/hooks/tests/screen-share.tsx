import { View, StyleSheet } from 'react-native';
import { useScreenShare } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function ScreenShareTest() {
  const {
    isScreenSharing,
    screenShareTrack,
    startScreenShare,
    stopScreenShare,
  } = useScreenShare();

  return (
    <TestScreen
      title="useScreenShare"
      description="Share your device screen with other participants in the call."
      controls={
        <View style={styles.row}>
          <TestButton
            title="Start Sharing"
            onPress={startScreenShare}
            disabled={isScreenSharing}
          />
          <TestButton
            title="Stop Sharing"
            onPress={stopScreenShare}
            variant="danger"
            disabled={!isScreenSharing}
          />
        </View>
      }
      state={
        <>
          <StatusBadge label="Screen Sharing" value={isScreenSharing} />
          <StatusBadge label="Has Track" value={!!screenShareTrack} />
        </>
      }
      debugData={{ isScreenSharing, hasTrack: !!screenShareTrack }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
});
