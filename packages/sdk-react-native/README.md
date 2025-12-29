# @chalk/react-native

React Native SDK for Chalk video conferencing platform. Built on Cloudflare RealtimeKit and react-native-webrtc.

## Installation

```bash
npm install @chalk/react-native react-native react-native-webrtc
```

### Peer Dependencies

- `react` (^18.0.0 or ^19.0.0)
- `react-native` (>=0.70.0)
- `react-native-webrtc` (>=118.0.0)

## Features

- **ChalkProvider**: Context provider for initializing the Chalk client
- **Hooks**: Full set of React hooks for managing room state, participants, media, chat, etc.
- **Components**: Pre-built components for video display, audio session management
- **Platform Support**: iOS and Android with native permission handling

## Quick Start

```tsx
import { ChalkProvider, useRoom, useParticipants, useMedia } from '@chalk/react-native';
import { VideoView, AudioSession } from '@chalk/react-native/components';

export default function App() {
  return (
    <ChalkProvider token="your-jwt-token">
      <CallScreen />
    </ChalkProvider>
  );
}

function CallScreen() {
  const { room, isConnected } = useRoom();
  const { participants } = useParticipants();
  const { isVideoEnabled, toggleVideo } = useMedia();

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

## API Reference

### Provider

- **ChalkProvider**: Initialize the SDK with authentication tokens
  - `token`: JWT token for authentication
  - `apiKey`: API key alternative (client-side only)
  - `apiUrl`: Custom API endpoint
  - `wsUrl`: Custom WebSocket endpoint

### Hooks

#### useRoom()
Access current room state and connection status.

```tsx
const { room, isConnected, status, isRecording } = useRoom();
```

#### useParticipants()
Get list of participants and active speaker.

```tsx
const { participants, localParticipant, activeSpeaker } = useParticipants();
```

#### useMedia()
Control local media (video, audio, screen share).

```tsx
const {
  isVideoEnabled,
  toggleVideo,
  isAudioEnabled,
  toggleAudio,
  isScreenSharing,
  startScreenShare,
  stopScreenShare
} = useMedia();
```

#### useDevices()
Enumerate and select cameras, microphones, and speakers.

```tsx
const {
  cameras,
  microphones,
  selectCamera,
  selectMicrophone
} = useDevices();
```

#### useChat()
Send and receive chat messages.

```tsx
const { messages, sendMessage } = useChat();
```

#### useRecording()
Control room recording.

```tsx
const {
  isRecording,
  startRecording,
  stopRecording,
  durationSeconds
} = useRecording();
```

#### usePermissions()
Manage runtime permissions for camera and microphone.

```tsx
const {
  permissions,           // { camera, microphone, notifications, bluetooth }
  hasRequiredPermissions, // true if camera + mic granted
  isChecking,
  requestPermissions,    // Request camera + mic
  openSettings,          // Open device settings
  showPermissionDeniedAlert
} = usePermissions();

// Pre-call permission check
useEffect(() => {
  if (!hasRequiredPermissions) {
    requestPermissions();
  }
}, [hasRequiredPermissions, requestPermissions]);
```

#### useScreenShare()
Control screen sharing (requires native setup - see [SETUP.md](./SETUP.md)).

```tsx
const {
  isScreenSharing,
  startScreenShare,
  stopScreenShare,
  error
} = useScreenShare();
```

#### useAudioRouting()
Control audio output routing (speaker, earpiece, Bluetooth).

```tsx
const {
  currentRoute,       // 'speaker' | 'earpiece' | 'bluetooth' | 'headphones'
  availableRoutes,
  setRoute,
  isSpeakerOn,
  toggleSpeaker
} = useAudioRouting();
```

### Components

#### VideoView
Render a video stream from a participant.

```tsx
<VideoView
  stream={mediaStream}
  mirror={true}
  objectFit="cover"
  style={{ flex: 1 }}
/>
```

#### ScreenShareView
Render a screen share stream.

```tsx
<ScreenShareView
  stream={screenStream}
  objectFit="contain"
/>
```

#### AudioSession
Manage iOS/Android audio routing (speakerphone, Bluetooth).

```tsx
<AudioSession useSpeaker={true}>
  <YourCallUI />
</AudioSession>
```

#### useSpeakerphone()
Hook to toggle speakerphone mode.

```tsx
const { isSpeakerOn, toggle } = useSpeakerphone();
```

#### useBluetoothAudio()
Hook to check Bluetooth audio availability.

```tsx
const { isBluetoothAvailable, isBluetoothConnected } = useBluetoothAudio();
```

## Platform-Specific Setup

**For complete setup instructions including background audio, screen sharing, and recording permissions, see [SETUP.md](./SETUP.md).**

### Quick Start - Basic Permissions

#### iOS

Add to `Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>$(PRODUCT_NAME) needs camera access for video calls</string>
<key>NSMicrophoneUsageDescription</key>
<string>$(PRODUCT_NAME) needs microphone access for voice calls</string>
```

#### Android

Add to `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

### Advanced Features

See [SETUP.md](./SETUP.md) for:
- **Background Audio**: Keep calls active when app is backgrounded
- **Screen Sharing**: iOS Broadcast Extension + Android MediaProjection setup
- **Recording**: Local recording permissions
- **CallKit**: Native iOS call UI integration
- **Foreground Service**: Android notification for ongoing calls

## Development

```bash
# Type checking
bun run check-types

# Build
bun run build

# Tests
bun test

# Watch mode
bun run dev
```

## Architecture

The SDK is organized into layers:

1. **ChalkProvider** - Context and state management
2. **Hooks** - React hooks for component-level access
3. **Components** - Pre-built UI components for common use cases
4. **RTCManager** - Native WebRTC wrapper
5. **Core** - Low-level SDK integration (@chalk/core)

## Error Handling

```tsx
import { ChalkErrorCode } from '@chalk/react-native';

const { room } = useChalk();

room?.on('error', (error) => {
  if (error.code === ChalkErrorCode.CAMERA_ACCESS_DENIED) {
    // Handle permission denial
  }
});
```

## License

MIT
