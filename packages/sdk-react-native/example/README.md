# Chalk React Native Example

Minimal example app demonstrating `@q9labs/chalk-react-native` SDK.

## Setup

```bash
# Install dependencies
bun install

# iOS: Install CocoaPods
cd ios && pod install && cd ..

# Start Metro bundler
bun run start
```

## Run

```bash
# iOS
bun run ios

# Android
bun run android
```

## Structure

```
src/
├── App.tsx              # Root component with navigation state
└── screens/
    ├── HomeScreen.tsx   # Room ID entry
    ├── PreCallScreen.tsx # Permissions & device preview
    └── CallScreen.tsx   # Active call UI
```

## Notes

- Uses react-native-webrtc for WebRTC support
- Requires camera/microphone permissions
- iOS: Background modes enabled for VoIP
- Android: Foreground service permissions for calls
