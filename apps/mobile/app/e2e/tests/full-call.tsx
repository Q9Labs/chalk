import { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import {
  useChalk,
  useMedia,
  useParticipants,
  useChat,
  VideoGrid,
} from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

type Step = 'config' | 'joining' | 'in-call' | 'left';

export default function FullCallFlow() {
  const [step, setStep] = useState<Step>('config');
  const [roomId, setRoomId] = useState('test-room-e2e');
  const [displayName, setDisplayName] = useState('E2E Tester');
  const [message, setMessage] = useState('');

  const { joinRoom, leaveRoom, connectionStatus, createRoom } = useChalk();
  const { isAudioEnabled, isVideoEnabled, toggleAudio, toggleVideo } = useMedia();
  const { participants } = useParticipants();
  const { messages, sendMessage } = useChat();

  const handleJoin = async () => {
    setStep('joining');
    try {
      await joinRoom(roomId, { displayName, audio: true, video: true });
      setStep('in-call');
    } catch (err) {
      console.error('Failed to join:', err);
      setStep('config');
    }
  };

  const handleLeave = async () => {
    await leaveRoom();
    setStep('left');
  };

  const handleCreateAndJoin = async () => {
    try {
      const newRoomId = await createRoom(`E2E Room ${Date.now()}`);
      setRoomId(newRoomId);
      setStep('joining');
      await joinRoom(newRoomId, { displayName, audio: true, video: true });
      setStep('in-call');
    } catch (err) {
      console.error('Failed to create/join:', err);
      setStep('config');
    }
  };

  const handleSendMessage = () => {
    if (message.trim()) {
      sendMessage(message.trim());
      setMessage('');
    }
  };

  const renderStep = () => {
    switch (step) {
      case 'config':
        return (
          <>
            <Text style={styles.stepTitle}>Configure Call</Text>
            <TextInput
              style={styles.input}
              value={roomId}
              onChangeText={setRoomId}
              placeholder="Room ID"
            />
            <TextInput
              style={styles.input}
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="Display Name"
            />
            <View style={styles.row}>
              <TestButton title="Join Room" onPress={handleJoin} />
              <TestButton title="Create & Join" onPress={handleCreateAndJoin} variant="secondary" />
            </View>
          </>
        );

      case 'joining':
        return (
          <>
            <Text style={styles.stepTitle}>Joining...</Text>
            <Text style={styles.stepDescription}>Connecting to {roomId}</Text>
            <StatusBadge label="Status" value={connectionStatus} color="yellow" />
          </>
        );

      case 'in-call':
        return (
          <>
            <Text style={styles.stepTitle}>In Call</Text>

            <View style={styles.videoContainer}>
              <VideoGrid participants={participants} maxColumns={2} style={styles.videoGrid} />
            </View>

            <View style={styles.controls}>
              <TestButton
                title={isAudioEnabled ? 'Mute' : 'Unmute'}
                onPress={toggleAudio}
                variant={isAudioEnabled ? 'danger' : 'primary'}
              />
              <TestButton
                title={isVideoEnabled ? 'Stop Video' : 'Start Video'}
                onPress={toggleVideo}
                variant={isVideoEnabled ? 'danger' : 'primary'}
              />
            </View>

            <View style={styles.chatSection}>
              <Text style={styles.sectionLabel}>Chat ({messages.length})</Text>
              <View style={styles.chatInputRow}>
                <TextInput
                  style={styles.chatInput}
                  value={message}
                  onChangeText={setMessage}
                  placeholder="Type a message..."
                  onSubmitEditing={handleSendMessage}
                />
                <TestButton title="Send" onPress={handleSendMessage} />
              </View>
            </View>

            <TestButton title="Leave Call" onPress={handleLeave} variant="danger" />
          </>
        );

      case 'left':
        return (
          <>
            <Text style={styles.stepTitle}>Call Ended</Text>
            <Text style={styles.stepDescription}>You have left the room.</Text>
            <View style={styles.summary}>
              <Text style={styles.summaryText}>Room: {roomId}</Text>
              <Text style={styles.summaryText}>Messages sent: {messages.length}</Text>
            </View>
            <TestButton title="Join Another Call" onPress={() => setStep('config')} />
          </>
        );
    }
  };

  return (
    <TestScreen
      title="Full Call Flow"
      description="End-to-end call experience: join, interact, and leave."
      controls={
        <View style={styles.statusBar}>
          <StatusBadge label="Status" value={connectionStatus} color={connectionStatus === 'connected' ? 'green' : 'gray'} />
          <StatusBadge label="Participants" value={participants.length} />
        </View>
      }
      state={<View style={styles.stepContent}>{renderStep()}</View>}
      debugData={{ step, connectionStatus, participantCount: participants.length, messageCount: messages.length }}
    />
  );
}

const styles = StyleSheet.create({
  statusBar: {
    flexDirection: 'row',
    gap: 16,
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
  },
  input: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  videoContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
  },
  videoGrid: {
    height: 200,
  },
  controls: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
  },
  chatSection: {
    gap: 8,
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  chatInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  summary: {
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  summaryText: {
    fontSize: 14,
    color: '#666',
  },
});
