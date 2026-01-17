import { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { ParticipantTile, useParticipants, useLocalStream } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function ParticipantTileTest() {
  const [showName, setShowName] = useState(true);
  const [showMuteIndicator, setShowMuteIndicator] = useState(true);
  const { participants, localParticipant } = useParticipants();
  const { startPreview, stopPreview, isPreviewActive } = useLocalStream();

  const participant = localParticipant ?? participants[0];

  return (
    <TestScreen
      title="ParticipantTile"
      description="Displays a participant's video with name and status indicators."
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
              title={`Name: ${showName ? 'On' : 'Off'}`}
              onPress={() => setShowName(!showName)}
              variant="secondary"
            />
            <TestButton
              title={`Mute: ${showMuteIndicator ? 'On' : 'Off'}`}
              onPress={() => setShowMuteIndicator(!showMuteIndicator)}
              variant="secondary"
            />
          </View>
        </>
      }
      state={
        <>
          <StatusBadge label="Has Participant" value={!!participant} />
          <StatusBadge label="Show Name" value={showName} />
          <StatusBadge label="Show Mute" value={showMuteIndicator} />

          <View style={styles.tileContainer}>
            {participant && (
              <ParticipantTile
                participant={participant}
                style={styles.tile}
                showName={showName}
                showMuteIndicator={showMuteIndicator}
              />
            )}
          </View>
        </>
      }
      debugData={{ hasParticipant: !!participant, showName, showMuteIndicator }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  tileContainer: {
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  tile: {
    width: '100%',
    aspectRatio: 4 / 3,
  },
});
