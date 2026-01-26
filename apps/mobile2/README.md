# Chalk Mobile App

Ultra low-latency video conferencing for education - React Native mobile app.

## Architecture Constraints

This app is configured with specific constraints to ensure stability:

| Setting | Value | Reason |
|---------|-------|--------|
| New Architecture | OFF | Avoids crashes with Reanimated worklets + native WebRTC |
| Hermes | ON | Required for performance |
| Reanimated | v3.x only | v4 breaks worklet compatibility |

**Do not change these settings without thorough testing.**

## Setup

```bash
# From monorepo root
bun install

# Build SDK first (required - mobile resolves to dist/)
cd packages/sdk-react-native && bun run build

# Generate native projects
cd apps/mobile2
npx expo prebuild --clean

# Install iOS pods
cd ios && pod install && cd ..

# Run dev client
npx expo run:ios
# or
npx expo run:android
```

## Environment Variables

Copy `.env.example` to `.env.local` and configure:

```bash
EXPO_PUBLIC_API_URL=https://chalk-api.q9labs.ai
EXPO_PUBLIC_WS_URL=wss://chalk-api.q9labs.ai
EXPO_PUBLIC_CHALK_API_KEY=ck_live_xxx
EXPO_PUBLIC_DEBUG=true
```

## Simulator Limitations

- Camera/microphone not available on iOS Simulator
- Use physical device for full WebRTC testing
- `RTCManager.enumerateDevices()` returns mock data on simulator

## Development

```bash
# Start dev server
npx expo start --dev-client --clear

# Clear Metro cache (if needed)
npx expo start --clear
```

## Troubleshooting

### "SDK components not available"
Build the SDK first: `cd packages/sdk-react-native && bun run build`

### "Multiple React instances" error
Check that `bunfig.toml` has `hoist = false` and metro.config.js forces single React.

### Pod install fails
Try: `cd ios && pod deintegrate && pod install`
