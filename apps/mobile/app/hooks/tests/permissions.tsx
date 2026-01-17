import { View, StyleSheet } from 'react-native';
import { usePermissions } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function PermissionsTest() {
  const {
    camera,
    microphone,
    requestCameraPermission,
    requestMicrophonePermission,
    requestAllPermissions,
    checkPermissions,
  } = usePermissions();

  return (
    <TestScreen
      title="usePermissions"
      description="Check and request camera/microphone permissions for iOS and Android."
      controls={
        <>
          <TestButton title="Check Permissions" onPress={checkPermissions} variant="secondary" />
          <View style={styles.row}>
            <TestButton title="Request Camera" onPress={requestCameraPermission} />
            <TestButton title="Request Mic" onPress={requestMicrophonePermission} />
          </View>
          <TestButton title="Request All" onPress={requestAllPermissions} />
        </>
      }
      state={
        <>
          <StatusBadge
            label="Camera"
            value={camera}
            color={camera === 'granted' ? 'green' : camera === 'denied' ? 'red' : 'yellow'}
          />
          <StatusBadge
            label="Microphone"
            value={microphone}
            color={microphone === 'granted' ? 'green' : microphone === 'denied' ? 'red' : 'yellow'}
          />
        </>
      }
      debugData={{ camera, microphone }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
});
