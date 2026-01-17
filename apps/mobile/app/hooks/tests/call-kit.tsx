import { View, Text, StyleSheet, Platform } from 'react-native';
import { useCallKit } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function CallKitTest() {
  const {
    isCallActive,
    isCallKitSupported,
    reportIncomingCall,
    reportOutgoingCall,
    endCall,
  } = useCallKit();

  const handleIncomingCall = () => {
    reportIncomingCall({
      uuid: `call-${Date.now()}`,
      handle: 'Test Caller',
      callerName: 'Test Caller',
    });
  };

  const handleOutgoingCall = () => {
    reportOutgoingCall({
      uuid: `call-${Date.now()}`,
      handle: 'Test Recipient',
    });
  };

  if (Platform.OS !== 'ios') {
    return (
      <TestScreen
        title="useCallKit"
        description="CallKit is only available on iOS."
        state={
          <View style={styles.unsupported}>
            <Text style={styles.unsupportedText}>
              This hook is iOS-only. Use useForegroundService for Android.
            </Text>
          </View>
        }
        debugData={{ platform: Platform.OS }}
      />
    );
  }

  return (
    <TestScreen
      title="useCallKit"
      description="iOS CallKit integration for native call UI and system integration."
      controls={
        <>
          <View style={styles.row}>
            <TestButton
              title="Incoming Call"
              onPress={handleIncomingCall}
              disabled={!isCallKitSupported}
            />
            <TestButton
              title="Outgoing Call"
              onPress={handleOutgoingCall}
              disabled={!isCallKitSupported}
            />
          </View>
          <TestButton
            title="End Call"
            onPress={endCall}
            variant="danger"
            disabled={!isCallActive}
          />
        </>
      }
      state={
        <>
          <StatusBadge label="CallKit Supported" value={isCallKitSupported} />
          <StatusBadge label="Call Active" value={isCallActive} />
        </>
      }
      debugData={{ isCallActive, isCallKitSupported }}
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
