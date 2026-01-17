import { useState } from 'react';
import { View, Text, TextInput, StyleSheet, FlatList } from 'react-native';
import { useChat } from '@q9labs/chalk-react-native';
import { TestScreen, TestButton, StatusBadge } from '@/components/test/TestScreen';

export default function ChatTest() {
  const [message, setMessage] = useState('');
  const { messages, sendMessage, isConnected } = useChat();

  const handleSend = () => {
    if (message.trim()) {
      sendMessage(message.trim());
      setMessage('');
    }
  };

  return (
    <TestScreen
      title="useChat"
      description="Send and receive chat messages within a room."
      controls={
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={message}
            onChangeText={setMessage}
            placeholder="Type a message..."
            onSubmitEditing={handleSend}
          />
          <TestButton title="Send" onPress={handleSend} disabled={!message.trim()} />
        </View>
      }
      state={
        <>
          <StatusBadge label="Connected" value={isConnected} />
          <StatusBadge label="Messages" value={messages.length} />

          {messages.length > 0 && (
            <View style={styles.messageList}>
              <Text style={styles.listTitle}>Messages:</Text>
              <FlatList
                data={messages}
                keyExtractor={(m) => m.id}
                renderItem={({ item }) => (
                  <View style={styles.messageItem}>
                    <Text style={styles.sender}>{item.senderName}</Text>
                    <Text style={styles.messageText}>{item.content}</Text>
                    <Text style={styles.timestamp}>
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </Text>
                  </View>
                )}
                style={styles.list}
              />
            </View>
          )}
        </>
      }
      debugData={messages}
    />
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  messageList: {
    marginTop: 16,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    maxHeight: 300,
  },
  listTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
  },
  list: {
    maxHeight: 250,
  },
  messageItem: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  sender: {
    fontSize: 13,
    fontWeight: '600',
    color: '#007AFF',
  },
  messageText: {
    fontSize: 15,
    color: '#333',
    marginTop: 2,
  },
  timestamp: {
    fontSize: 11,
    color: '#888',
    marginTop: 4,
  },
});
