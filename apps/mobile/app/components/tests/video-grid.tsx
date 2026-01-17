import { useState } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { VideoGrid, useParticipants } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function VideoGridTest() {
  const [maxColumns, setMaxColumns] = useState(2);
  const { participants } = useParticipants();
  const { width } = Dimensions.get('window');

  return (
    <TestScreen
      title="VideoGrid"
      description="Automatically arranges participant videos in a responsive grid layout."
      controls={
        <View style={styles.row}>
          <TestButton
            title="1 Column"
            onPress={() => setMaxColumns(1)}
            variant={maxColumns === 1 ? 'primary' : 'secondary'}
          />
          <TestButton
            title="2 Columns"
            onPress={() => setMaxColumns(2)}
            variant={maxColumns === 2 ? 'primary' : 'secondary'}
          />
          <TestButton
            title="3 Columns"
            onPress={() => setMaxColumns(3)}
            variant={maxColumns === 3 ? 'primary' : 'secondary'}
          />
        </View>
      }
      state={
        <>
          <StatusBadge label="Participants" value={participants.length} />
          <StatusBadge label="Max Columns" value={maxColumns} />

          <View style={[styles.gridContainer, { width: width - 32 }]}>
            <VideoGrid
              participants={participants}
              maxColumns={maxColumns}
              style={styles.grid}
            />
          </View>
        </>
      }
      debugData={{ participantCount: participants.length, maxColumns }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  gridContainer: {
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
  },
  grid: {
    minHeight: 200,
  },
});
