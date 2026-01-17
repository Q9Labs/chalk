import { useState } from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { useRoom, useChalk } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function RoomTest() {
  const [roomId, setRoomId] = useState('test-room-1');
  const [displayName, setDisplayName] = useState('Test User');
  const { joinRoom, leaveRoom, createRoom, connectionStatus, roomInfo } = useChalk();
  const room = useRoom();

  const handleJoin = async () => {
    try {
      await joinRoom(roomId, { displayName, audio: true, video: true });
    } catch (err) {
      console.error('Join failed:', err);
    }
  };

  const handleLeave = async () => {
    try {
      await leaveRoom();
    } catch (err) {
      console.error('Leave failed:', err);
    }
  };

  const handleCreate = async () => {
    try {
      const newRoomId = await createRoom(`Room ${Date.now()}`);
      setRoomId(newRoomId);
    } catch (err) {
      console.error('Create failed:', err);
    }
  };

  return (
    <TestScreen
      title="useRoom"
      description="Manage room connection lifecycle: join, leave, and monitor connection status."
      controls={
        <>
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
            <TestButton title="Create Room" onPress={handleCreate} variant="secondary" />
            <TestButton
              title="Join"
              onPress={handleJoin}
              disabled={connectionStatus === 'connected'}
            />
            <TestButton
              title="Leave"
              onPress={handleLeave}
              variant="danger"
              disabled={connectionStatus === 'disconnected'}
            />
          </View>
        </>
      }
      state={
        <>
          <StatusBadge label="Status" value={connectionStatus} color={connectionStatus === 'connected' ? 'green' : connectionStatus === 'connecting' ? 'yellow' : 'gray'} />
          <StatusBadge label="Room ID" value={roomInfo?.roomId ?? 'N/A'} />
          <StatusBadge label="Participant ID" value={roomInfo?.participantId ?? 'N/A'} />
        </>
      }
      debugData={{ room, roomInfo, connectionStatus }}
    />
  );
}

const styles = StyleSheet.create({
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
});
