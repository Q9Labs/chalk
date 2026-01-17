import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useAudioRouting } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function AudioRoutingTest() {
  const {
    currentRoute,
    availableRoutes,
    isSpeakerOn,
    isBluetoothAvailable,
    setRoute,
    toggleSpeaker,
  } = useAudioRouting();

  return (
    <TestScreen
      title="useAudioRouting"
      description="Control audio output routing: speaker, earpiece, or bluetooth devices."
      controls={
        <View style={styles.row}>
          <TestButton
            title={isSpeakerOn ? 'Earpiece' : 'Speaker'}
            onPress={toggleSpeaker}
          />
        </View>
      }
      state={
        <>
          <StatusBadge label="Current Route" value={currentRoute ?? 'Unknown'} />
          <StatusBadge label="Speaker On" value={isSpeakerOn} />
          <StatusBadge label="Bluetooth Available" value={isBluetoothAvailable} />

          {availableRoutes.length > 0 && (
            <View style={styles.routeList}>
              <Text style={styles.listTitle}>Available Routes:</Text>
              {availableRoutes.map((route) => (
                <TouchableOpacity
                  key={route}
                  style={[
                    styles.routeItem,
                    currentRoute === route && styles.selectedRoute,
                  ]}
                  onPress={() => setRoute(route)}
                >
                  <Text style={styles.routeName}>{route}</Text>
                  {currentRoute === route && (
                    <Text style={styles.selectedBadge}>Active</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </>
      }
      debugData={{ currentRoute, availableRoutes, isSpeakerOn, isBluetoothAvailable }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  routeList: {
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
  routeItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 4,
  },
  selectedRoute: {
    backgroundColor: '#e3f2fd',
  },
  routeName: {
    fontSize: 15,
    color: '#333',
    textTransform: 'capitalize',
  },
  selectedBadge: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '600',
  },
});
