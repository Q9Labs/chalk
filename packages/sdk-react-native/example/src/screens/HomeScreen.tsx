import React, {useState} from 'react';
import {View, Text, TextInput, TouchableOpacity, StyleSheet} from 'react-native';

interface HomeScreenProps {
  onJoin: (roomId: string) => void;
}

export function HomeScreen({onJoin}: HomeScreenProps) {
  const [roomId, setRoomId] = useState('');

  const handleJoin = () => {
    const id = roomId.trim() || `test-${Date.now()}`;
    onJoin(id);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Chalk Video</Text>
      <Text style={styles.subtitle}>React Native SDK Example</Text>

      <TextInput
        style={styles.input}
        placeholder="Enter Room ID (optional)"
        placeholderTextColor="#888"
        value={roomId}
        onChangeText={setRoomId}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <TouchableOpacity style={styles.button} onPress={handleJoin}>
        <Text style={styles.buttonText}>
          {roomId ? 'Join Room' : 'Create & Join Room'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.version}>SDK v0.1.0</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 48,
  },
  input: {
    width: '100%',
    height: 50,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 16,
    color: '#333',
  },
  button: {
    width: '100%',
    height: 50,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  version: {
    marginTop: 48,
    color: '#999',
    fontSize: 12,
  },
});
