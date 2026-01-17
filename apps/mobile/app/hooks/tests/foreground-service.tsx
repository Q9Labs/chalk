import { View, Text, StyleSheet, Platform } from 'react-native';
import { useForegroundService } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function ForegroundServiceTest() {
  const {
    isServiceRunning,
    startService,
    stopService,
    updateNotification,
  } = useForegroundService();

  const handleStart = () => {
    startService({
      title: 'Chalk Call',
      body: 'Call in progress',
      icon: 'ic_notification',
    });
  };

  const handleUpdate = () => {
    updateNotification({
      title: 'Chalk Call',
      body: `Call duration: ${Math.floor(Math.random() * 60)}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`,
    });
  };

  if (Platform.OS !== 'android') {
    return (
      <TestScreen
        title="useForegroundService"
        description="Foreground Service is only available on Android."
        state={
          <View style={styles.unsupported}>
            <Text style={styles.unsupportedText}>
              This hook is Android-only. Use useCallKit for iOS.
            </Text>
          </View>
        }
        debugData={{ platform: Platform.OS }}
      />
    );
  }

  return (
    <TestScreen
      title="useForegroundService"
      description="Android foreground service for background call support and persistent notification."
      controls={
        <>
          <View style={styles.row}>
            <TestButton
              title="Start Service"
              onPress={handleStart}
              disabled={isServiceRunning}
            />
            <TestButton
              title="Stop Service"
              onPress={stopService}
              variant="danger"
              disabled={!isServiceRunning}
            />
          </View>
          <TestButton
            title="Update Notification"
            onPress={handleUpdate}
            variant="secondary"
            disabled={!isServiceRunning}
          />
        </>
      }
      state={
        <StatusBadge label="Service Running" value={isServiceRunning} />
      }
      debugData={{ isServiceRunning }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  unsupported: {
    padding: 16,
    backgroundColor: '#fff3cd',
    borderRadius: 8,
  },
  unsupportedText: {
    fontSize: 14,
    color: '#856404',
    textAlign: 'center',
  },
});
