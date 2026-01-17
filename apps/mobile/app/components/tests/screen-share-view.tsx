import { View, StyleSheet, Text } from 'react-native';
import { ScreenShareView, useScreenShare, useParticipants } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function ScreenShareViewTest() {
  const { isScreenSharing, screenShareTrack, startScreenShare, stopScreenShare } = useScreenShare();
  const { participants } = useParticipants();

  const screenSharer = participants.find((p) => p.screenShareTrack);

  return (
    <TestScreen
      title="ScreenShareView"
      description="Renders a screen share stream from any participant."
      controls={
        <View style={styles.row}>
          <TestButton
            title={isScreenSharing ? 'Stop Share' : 'Start Share'}
            onPress={isScreenSharing ? stopScreenShare : startScreenShare}
            variant={isScreenSharing ? 'danger' : 'primary'}
          />
        </View>
      }
      state={
        <>
          <StatusBadge label="Local Sharing" value={isScreenSharing} />
          <StatusBadge label="Screen Share Active" value={!!screenSharer} />

          <View style={styles.videoContainer}>
            {screenShareTrack || screenSharer?.screenShareTrack ? (
              <ScreenShareView
                track={screenShareTrack ?? screenSharer?.screenShareTrack}
                style={styles.video}
              />
            ) : (
              <View style={styles.placeholder}>
                <Text style={styles.placeholderText}>No screen share active</Text>
              </View>
            )}
          </View>
        </>
      }
      debugData={{ isScreenSharing, hasScreenSharer: !!screenSharer }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  videoContainer: {
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
  },
  placeholder: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: '#666',
    fontSize: 14,
  },
});
