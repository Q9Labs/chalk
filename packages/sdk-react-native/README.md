# @chalk/react-native

React Native SDK for Chalk video conferencing. Built on Cloudflare RealtimeKit + react-native-webrtc.

## Installation

```bash
npm install @chalk/react-native react-native react-native-webrtc
```

**Peer dependencies:** `react` ^18/19, `react-native` >=0.70, `react-native-webrtc` >=118

## Quick Start

### Single Component (Recommended)

```tsx
import { createTokenProvider } from '@q9labs/chalk-core';
import { VideoConference } from '@chalk/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const tokenProvider = createTokenProvider({
  apiKey: 'ck_live_xxx',
  apiUrl: 'https://api.chalk.example.com',
  storage: {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: (key) => AsyncStorage.removeItem(key),
  },
});

export default function App() {
  return (
    <VideoConference
      roomId="room_123"
      displayName="Ada Lovelace"
      provider={{ tokenProvider }}
      onEnd={(data) => console.log('ended', data)}
    />
  );
}
```

### Custom UI (Hooks + Components)

```tsx
import { createTokenProvider } from '@q9labs/chalk-core';
import { ChalkProvider, useRoom, useParticipants, useMedia } from '@chalk/react-native';
import { VideoView, AudioSession } from '@chalk/react-native/components';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Create token provider with AsyncStorage
const tokenProvider = createTokenProvider({
  apiKey: 'ck_live_xxx',
  apiUrl: 'https://api.chalk.example.com',
  storage: {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: (key) => AsyncStorage.removeItem(key),
  },
});

export default function App() {
  return (
    <ChalkProvider tokenProvider={tokenProvider}>
      <CallScreen />
    </ChalkProvider>
  );
}

function CallScreen() {
  const { isConnected } = useRoom();
  const { participants } = useParticipants();
  const { toggleVideo } = useMedia();

  if (!isConnected) return <Text>Connecting...</Text>;

  return (
    <AudioSession useSpeaker={true}>
      <View style={{ flex: 1 }}>
        {participants.map(p => (
          <VideoView key={p.id} stream={p.videoTrack ? new MediaStream([p.videoTrack]) : null} />
        ))}
      </View>
    </AudioSession>
  );
}
```

## Core Hooks

| Hook | Purpose |
|------|---------|
| `useRoom()` | Room state, connection status, recording state |
| `useParticipants()` | Participants list, local participant, active speaker |
| `useMedia()` | Toggle video/audio/screen share |
| `useDevices()` | Camera/mic selection |
| `useChat()` | Send/receive messages |
| `useRecording()` | Start/stop recording |
| `usePermissions()` | Request camera/mic permissions |
| `useScreenShare()` | Screen sharing control |
| `useAudioRouting()` | Speaker/earpiece/Bluetooth routing |

## Components

- **VideoView** - Render participant video stream
- **ScreenShareView** - Render screen share stream
- **AudioSession** - Manage iOS/Android audio routing
- **useSpeakerphone()** - Toggle speakerphone
- **useBluetoothAudio()** - Bluetooth availability

## Platform Setup

**See [SETUP.md](./SETUP.md) for:**
- Background audio (iOS: AVAudioSession, Android: Foreground Service)
- Screen sharing (iOS: Broadcast Extension, Android: MediaProjection)
- Permissions (camera, microphone, Bluetooth)
- CallKit (iOS native call UI)

### Quick Permissions

**iOS** - Add to `Info.plist`:
```xml
<key>NSCameraUsageDescription</key>
<string>$(PRODUCT_NAME) needs camera for video calls</string>
<key>NSMicrophoneUsageDescription</key>
<string>$(PRODUCT_NAME) needs microphone for calls</string>
```

**Android** - Add to `AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

## Development

```bash
bun run check-types    # Type check
bun run build          # Build
bun test               # Test
bun run dev            # Watch mode
```

## License

MIT
