import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  usePermissions,
  useDevices,
  useLocalStream,
  VideoView,
} from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

type Step = 'permissions' | 'devices' | 'preview' | 'ready';

export default function PreCallFlow() {
  const [step, setStep] = useState<Step>('permissions');

  const { camera, microphone, requestAllPermissions } = usePermissions();
  const { videoInputs, audioInputs, refreshDevices, selectVideoInput } = useDevices();
  const { localStream, isPreviewActive, startPreview, stopPreview } = useLocalStream();

  const handleRequestPermissions = async () => {
    await requestAllPermissions();
    if (camera === 'granted' && microphone === 'granted') {
      setStep('devices');
    }
  };

  const handleDevicesReady = async () => {
    await refreshDevices();
    setStep('preview');
  };

  const handleStartPreview = async () => {
    await startPreview();
    setStep('ready');
  };

  const renderStep = () => {
    switch (step) {
      case 'permissions':
        return (
          <>
            <Text style={styles.stepTitle}>Step 1: Request Permissions</Text>
            <Text style={styles.stepDescription}>
              Grant camera and microphone access to enable video calling.
            </Text>
            <View style={styles.statusList}>
              <StatusBadge label="Camera" value={camera} color={camera === 'granted' ? 'green' : 'yellow'} />
              <StatusBadge label="Microphone" value={microphone} color={microphone === 'granted' ? 'green' : 'yellow'} />
            </View>
            <TestButton title="Request Permissions" onPress={handleRequestPermissions} />
            {camera === 'granted' && microphone === 'granted' && (
              <TestButton title="Next: Devices" onPress={() => setStep('devices')} variant="secondary" />
            )}
          </>
        );

      case 'devices':
        return (
          <>
            <Text style={styles.stepTitle}>Step 2: Select Devices</Text>
            <Text style={styles.stepDescription}>
              Choose your camera and microphone for the call.
            </Text>
            <View style={styles.statusList}>
              <StatusBadge label="Cameras" value={videoInputs.length} />
              <StatusBadge label="Microphones" value={audioInputs.length} />
            </View>
            {videoInputs.map((device) => (
              <TestButton
                key={device.deviceId}
                title={device.label || 'Camera'}
                onPress={() => selectVideoInput(device.deviceId)}
                variant="secondary"
              />
            ))}
            <TestButton title="Next: Preview" onPress={handleDevicesReady} />
          </>
        );

      case 'preview':
        return (
          <>
            <Text style={styles.stepTitle}>Step 3: Camera Preview</Text>
            <Text style={styles.stepDescription}>
              Check your camera before joining the call.
            </Text>
            <TestButton
              title={isPreviewActive ? 'Stop Preview' : 'Start Preview'}
              onPress={isPreviewActive ? stopPreview : handleStartPreview}
              variant={isPreviewActive ? 'danger' : 'primary'}
            />
            {localStream && (
              <View style={styles.previewContainer}>
                <VideoView stream={localStream} style={styles.preview} mirror />
              </View>
            )}
            {isPreviewActive && (
              <TestButton title="Ready to Join" onPress={() => setStep('ready')} variant="secondary" />
            )}
          </>
        );

      case 'ready':
        return (
          <>
            <Text style={styles.stepTitle}>Ready to Join!</Text>
            <Text style={styles.stepDescription}>
              All pre-call checks passed. You can now join a room.
            </Text>
            <View style={styles.checkList}>
              <Text style={styles.checkItem}>Permissions granted</Text>
              <Text style={styles.checkItem}>Devices enumerated</Text>
              <Text style={styles.checkItem}>Camera preview working</Text>
            </View>
            <TestButton title="Restart Flow" onPress={() => setStep('permissions')} variant="secondary" />
          </>
        );
    }
  };

  return (
    <TestScreen
      title="Pre-call Flow"
      description="Complete pre-call setup: permissions, device selection, and camera preview."
      controls={
        <View style={styles.stepIndicator}>
          {(['permissions', 'devices', 'preview', 'ready'] as Step[]).map((s, i) => (
            <View
              key={s}
              style={[
                styles.stepDot,
                step === s && styles.stepDotActive,
                (['permissions', 'devices', 'preview', 'ready'] as Step[]).indexOf(step) > i && styles.stepDotComplete,
              ]}
            />
          ))}
        </View>
      }
      state={<View style={styles.stepContent}>{renderStep()}</View>}
      debugData={{ step, camera, microphone, videoInputs: videoInputs.length, isPreviewActive }}
    />
  );
}

const styles = StyleSheet.create({
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  stepDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#ddd',
  },
  stepDotActive: {
    backgroundColor: '#007AFF',
    transform: [{ scale: 1.2 }],
  },
  stepDotComplete: {
    backgroundColor: '#34C759',
  },
  stepContent: {
    gap: 16,
  },
  stepTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  stepDescription: {
    fontSize: 15,
    color: '#666',
    lineHeight: 22,
  },
  statusList: {
    gap: 8,
  },
  previewContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  preview: {
    width: '100%',
    aspectRatio: 4 / 3,
  },
  checkList: {
    backgroundColor: '#e8f5e9',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  checkItem: {
    fontSize: 15,
    color: '#2e7d32',
  },
});
