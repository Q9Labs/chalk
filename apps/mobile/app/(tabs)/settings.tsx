import { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TestButton } from '@/components/test/TestScreen';
import { env } from '@/lib/env';
import { storage } from '@/lib/storage';

export default function Settings() {
  const [apiUrl, setApiUrl] = useState(env.apiUrl);
  const [apiKey, setApiKey] = useState(env.apiKey);
  const [token, setToken] = useState('');

  const handleSaveToken = async () => {
    if (token) {
      await storage.setToken(token);
      Alert.alert('Saved', 'Token saved to storage');
    }
  };

  const handleClearTokens = async () => {
    await storage.clearTokens();
    setToken('');
    Alert.alert('Cleared', 'All tokens cleared');
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <View style={styles.section}>
          <Text style={styles.label}>API URL</Text>
          <TextInput
            style={styles.input}
            value={apiUrl}
            onChangeText={setApiUrl}
            placeholder="https://chalk-api.q9labs.ai"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>API Key</Text>
          <TextInput
            style={styles.input}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="ck_live_xxx"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>JWT Token (for testing)</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={token}
            onChangeText={setToken}
            placeholder="Paste JWT token here"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            numberOfLines={3}
          />
          <View style={styles.buttonRow}>
            <TestButton title="Save Token" onPress={handleSaveToken} />
            <TestButton
              title="Clear Tokens"
              onPress={handleClearTokens}
              variant="danger"
            />
          </View>
        </View>

        <View style={styles.info}>
          <Text style={styles.infoText}>
            Environment variables are set via .env file and require app restart
            to take effect.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    padding: 16,
  },
  title: {
    fontSize: 34,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 24,
  },
  section: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
  },
  info: {
    marginTop: 24,
    padding: 16,
    backgroundColor: '#fff3cd',
    borderRadius: 10,
  },
  infoText: {
    fontSize: 14,
    color: '#856404',
    lineHeight: 20,
  },
});
