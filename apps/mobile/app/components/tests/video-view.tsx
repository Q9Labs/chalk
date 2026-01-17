import { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { VideoView, useLocalStream, useParticipants } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function VideoViewTest() {
  const [mirror, setMirror] = useState(true);
  const [objectFit, setObjectFit] = useState<'cover' | 'contain'>('cover');
  const { localStream, isPreviewActive, startPreview, stopPreview } = useLocalStream();
  const { localParticipant } = useParticipants();

  const stream = localStream ?? localParticipant?.videoTrack;

  return (
    <TestScreen
      title="VideoView"
      description="Renders a single video stream from a participant or local preview."
      controls={
        <>
          <View style={styles.row}>
            <TestButton
              title={isPreviewActive ? 'Stop Preview' : 'Start Preview'}
              onPress={isPreviewActive ? stopPreview : startPreview}
              variant={isPreviewActive ? 'danger' : 'primary'}
            />
          </View>
          <View style={styles.row}>
            <TestButton
              title={`Mirror: ${mirror ? 'On' : 'Off'}`}
              onPress={() => setMirror(!mirror)}
              variant="secondary"
            />
            <TestButton
              title={`Fit: ${objectFit}`}
              onPress={() => setObjectFit(objectFit === 'cover' ? 'contain' : 'cover')}
              variant="secondary"
            />
          </View>
        </>
      }
      state={
        <>
          <StatusBadge label="Has Stream" value={!!stream} />
          <StatusBadge label="Mirror" value={mirror} />
          <StatusBadge label="Object Fit" value={objectFit} />

          <View style={styles.videoContainer}>
            {stream ? (
              <VideoView
                stream={stream}
                style={styles.video}
                mirror={mirror}
                objectFit={objectFit}
              />
            ) : (
              <View style={styles.placeholder} />
            )}
          </View>
        </>
      }
      debugData={{ hasStream: !!stream, mirror, objectFit }}
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
  },
});
