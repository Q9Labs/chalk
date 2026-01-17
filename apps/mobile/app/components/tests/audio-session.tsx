import { useState, type ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AudioSession, useAudioRouting } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function AudioSessionTest() {
  const [useSpeaker, setUseSpeaker] = useState(true);
  const [isActive, setIsActive] = useState(false);
  const { currentRoute, isSpeakerOn } = useAudioRouting();

  const renderChildren = (children: ReactNode) => (
    <View style={styles.sessionContent}>
      <Text style={styles.sessionText}>Audio Session Active</Text>
      {children}
    </View>
  );

  return (
    <TestScreen
      title="AudioSession"
      description="Wrapper component that configures iOS/Android audio session settings."
      controls={
        <View style={styles.row}>
          <TestButton
            title={`Speaker: ${useSpeaker ? 'On' : 'Off'}`}
            onPress={() => setUseSpeaker(!useSpeaker)}
            variant="secondary"
          />
          <TestButton
            title={isActive ? 'Deactivate' : 'Activate'}
            onPress={() => setIsActive(!isActive)}
            variant={isActive ? 'danger' : 'primary'}
          />
        </View>
      }
      state={
        <>
          <StatusBadge label="Use Speaker" value={useSpeaker} />
          <StatusBadge label="Session Active" value={isActive} />
          <StatusBadge label="Current Route" value={currentRoute ?? 'Unknown'} />
          <StatusBadge label="Speaker On" value={isSpeakerOn} />

          <View style={styles.sessionContainer}>
            {isActive ? (
              <AudioSession useSpeaker={useSpeaker}>
                {renderChildren(
                  <Text style={styles.routeText}>Route: {currentRoute}</Text>
                )}
              </AudioSession>
            ) : (
              <View style={styles.inactiveSession}>
                <Text style={styles.inactiveText}>Session Inactive</Text>
              </View>
            )}
          </View>
        </>
      }
      debugData={{ useSpeaker, isActive, currentRoute, isSpeakerOn }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  sessionContainer: {
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  sessionContent: {
    backgroundColor: '#e8f5e9',
    padding: 24,
    alignItems: 'center',
  },
  sessionText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#2e7d32',
    marginBottom: 8,
  },
  routeText: {
    fontSize: 14,
    color: '#388e3c',
  },
  inactiveSession: {
    backgroundColor: '#f5f5f5',
    padding: 24,
    alignItems: 'center',
  },
  inactiveText: {
    fontSize: 16,
    color: '#999',
  },
});
