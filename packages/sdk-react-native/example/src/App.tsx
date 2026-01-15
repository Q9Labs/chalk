import React, {useState} from 'react';
import {SafeAreaView, StatusBar, StyleSheet, useColorScheme} from 'react-native';
import {ChalkProvider} from '@q9labs/chalk-react-native';
import {HomeScreen} from './screens/HomeScreen';
import {PreCallScreen} from './screens/PreCallScreen';
import {CallScreen} from './screens/CallScreen';

// TODO: Replace with your Chalk API URL
const CHALK_API_URL = 'https://api.chalk.dev';

type Screen = 'home' | 'precall' | 'call';

export default function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [screen, setScreen] = useState<Screen>('home');
  const [roomId, setRoomId] = useState('');

  const navigateTo = (s: Screen, room?: string) => {
    if (room) setRoomId(room);
    setScreen(s);
  };

  return (
    <ChalkProvider apiUrl={CHALK_API_URL} debug>
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
