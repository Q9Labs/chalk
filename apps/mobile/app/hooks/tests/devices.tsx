import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useDevices } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function DevicesTest() {
  const {
    audioInputs,
    audioOutputs,
    videoInputs,
    selectedAudioInput,
    selectedVideoInput,
    refreshDevices,
    selectAudioInput,
    selectVideoInput,
  } = useDevices();

  return (
    <TestScreen
      title="useDevices"
      description="Enumerate and select audio/video devices: cameras, microphones, and speakers."
      controls={
        <TestButton title="Refresh Devices" onPress={refreshDevices} />
      }
      state={
        <>
          <StatusBadge label="Audio Inputs" value={audioInputs.length} />
          <StatusBadge label="Audio Outputs" value={audioOutputs.length} />
          <StatusBadge label="Video Inputs" value={videoInputs.length} />

          {videoInputs.length > 0 && (
            <View style={styles.deviceList}>
              <Text style={styles.listTitle}>Cameras:</Text>
              {videoInputs.map((device) => (
                <TouchableOpacity
                  key={device.deviceId}
                  style={[
                    styles.deviceItem,
                    selectedVideoInput?.deviceId === device.deviceId && styles.selectedDevice,
                  ]}
                  onPress={() => selectVideoInput(device.deviceId)}
                >
                  <Text style={styles.deviceName}>{device.label || 'Camera'}</Text>
                  {selectedVideoInput?.deviceId === device.deviceId && (
                    <Text style={styles.selectedBadge}>Selected</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}

          {audioInputs.length > 0 && (
            <View style={styles.deviceList}>
              <Text style={styles.listTitle}>Microphones:</Text>
              {audioInputs.map((device) => (
                <TouchableOpacity
                  key={device.deviceId}
                  style={[
                    styles.deviceItem,
                    selectedAudioInput?.deviceId === device.deviceId && styles.selectedDevice,
                  ]}
                  onPress={() => selectAudioInput(device.deviceId)}
                >
                  <Text style={styles.deviceName}>{device.label || 'Microphone'}</Text>
                  {selectedAudioInput?.deviceId === device.deviceId && (
                    <Text style={styles.selectedBadge}>Selected</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </>
      }
      debugData={{ audioInputs, audioOutputs, videoInputs, selectedAudioInput, selectedVideoInput }}
    />
  );
}

const styles = StyleSheet.create({
  deviceList: {
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
  deviceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 4,
  },
  selectedDevice: {
    backgroundColor: '#e3f2fd',
  },
  deviceName: {
    fontSize: 15,
    color: '#333',
  },
  selectedBadge: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '600',
  },
});
