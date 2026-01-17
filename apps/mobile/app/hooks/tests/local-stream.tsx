import { View, StyleSheet } from 'react-native';
import { useLocalStream, VideoView } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function LocalStreamTest() {
  const {
    localStream,
    isPreviewActive,
    startPreview,
    stopPreview,
    switchCamera,
  } = useLocalStream();

  return (
    <TestScreen
      title="useLocalStream"
      description="Access and preview local camera stream before joining a call."
      controls={
        <>
          <View style={styles.row}>
            <TestButton
              title="Start Preview"
              onPress={startPreview}
              disabled={isPreviewActive}
            />
            <TestButton
              title="Stop Preview"
              onPress={stopPreview}
              variant="danger"
              disabled={!isPreviewActive}
            />
          </View>
          <TestButton
            title="Switch Camera"
            onPress={switchCamera}
            variant="secondary"
            disabled={!isPreviewActive}
          />
        </>
      }
      state={
        <>
          <StatusBadge label="Preview Active" value={isPreviewActive} />
          <StatusBadge label="Has Stream" value={!!localStream} />

          {isPreviewActive && localStream && (
            <View style={styles.previewContainer}>
              <VideoView
                stream={localStream}
                style={styles.preview}
                mirror={true}
              />
            </View>
          )}
        </>
      }
      debugData={{ isPreviewActive, hasStream: !!localStream }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  previewContainer: {
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  preview: {
    width: '100%',
    aspectRatio: 4 / 3,
  },
});
