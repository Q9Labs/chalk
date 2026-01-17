import { useMedia } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';
import { View, StyleSheet } from 'react-native';

export default function MediaTest() {
  const {
    isAudioEnabled,
    isVideoEnabled,
    toggleAudio,
    toggleVideo,
    enableAudio,
    disableAudio,
    enableVideo,
    disableVideo,
  } = useMedia();

  return (
    <TestScreen
      title="useMedia"
      description="Control local audio and video tracks. Toggle microphone and camera on/off."
      controls={
        <>
          <View style={styles.row}>
            <TestButton
              title={isAudioEnabled ? 'Mute' : 'Unmute'}
              onPress={toggleAudio}
              variant={isAudioEnabled ? 'danger' : 'primary'}
            />
            <TestButton
              title={isVideoEnabled ? 'Stop Video' : 'Start Video'}
              onPress={toggleVideo}
              variant={isVideoEnabled ? 'danger' : 'primary'}
            />
          </View>
          <View style={styles.row}>
            <TestButton title="Enable Audio" onPress={enableAudio} variant="secondary" />
            <TestButton title="Disable Audio" onPress={disableAudio} variant="secondary" />
          </View>
          <View style={styles.row}>
            <TestButton title="Enable Video" onPress={enableVideo} variant="secondary" />
            <TestButton title="Disable Video" onPress={disableVideo} variant="secondary" />
          </View>
        </>
      }
      state={
        <>
          <StatusBadge label="Audio Enabled" value={isAudioEnabled} />
          <StatusBadge label="Video Enabled" value={isVideoEnabled} />
        </>
      }
      debugData={{ isAudioEnabled, isVideoEnabled }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
});
