import React, {useState, useCallback} from 'react';
import {SafeAreaView, StatusBar, StyleSheet, useColorScheme} from 'react-native';
import {ChalkProvider} from '@q9labs/chalk-react-native';
import {HomeScreen} from './screens/HomeScreen';
import {PreCallScreen} from './screens/PreCallScreen';
import {CallScreen} from './screens/CallScreen';

// Chalk API URL - uses demo mode for authentication
const CHALK_API_URL = 'https://chalk-api.q9labs.ai';

type Screen = 'home' | 'precall' | 'call';

// Simple in-memory token storage for React Native
// In production, use @react-native-async-storage/async-storage
const tokenStore: {access?: string; refresh?: string} = {};

export default function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [screen, setScreen] = useState<Screen>('home');
  const [roomId, setRoomId] = useState('');

  // Token provider for automatic JWT refresh
  // Returns empty string on first join (triggers normal demo auth flow)
  // After joining, stores tokens for future refresh
  const tokenProvider = useCallback(async (): Promise<string> => {
    if (!tokenStore.refresh) {
      // No refresh token yet - return empty to use demo join flow
      return '';
    }

    const response = await fetch(`${CHALK_API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenStore.refresh}`,
      },
    });

    if (!response.ok) {
      // Refresh failed - clear tokens
      tokenStore.access = undefined;
      tokenStore.refresh = undefined;
      throw new Error('Token refresh failed');
    }

    const data = await response.json();
    const newAccessToken = data.accessToken || data.access_token;

    if (newAccessToken) {
      tokenStore.access = newAccessToken;
    }
    if (data.refreshToken || data.refresh_token) {
      tokenStore.refresh = data.refreshToken || data.refresh_token;
    }

    return newAccessToken;
  }, []);

  const navigateTo = (s: Screen, room?: string) => {
    if (room) setRoomId(room);
    setScreen(s);
  };

  return (
    <ChalkProvider apiUrl={CHALK_API_URL} tokenProvider={tokenProvider} debug>
      <SafeAreaView style={[styles.container, isDarkMode && styles.dark]}>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
        {screen === 'home' && (
          <HomeScreen onJoin={(id) => navigateTo('precall', id)} />
        )}
        {screen === 'precall' && (
          <PreCallScreen
            roomId={roomId}
            onJoin={() => navigateTo('call')}
            onBack={() => navigateTo('home')}
          />
        )}
        {screen === 'call' && (
          <CallScreen roomId={roomId} onLeave={() => navigateTo('home')} />
        )}
      </SafeAreaView>
    </ChalkProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  dark: {
    backgroundColor: '#1a1a1a',
  },
});
