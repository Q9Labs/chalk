# Chalk React Native iOS Module

Native iOS module for Chalk video conferencing SDK, providing audio session management and route handling.

## Files

- **ChalkReactNative.podspec** - Pod specification for CocoaPods integration
- **ChalkReactNative.mm** - Objective-C++ bridge exposing Swift modules to React Native
- **ChalkReactNative-Bridging-Header.h** - Swift/Objective-C bridging header
- **AudioSessionModule.swift** - Native audio session management implementation

## AudioSessionModule

Manages audio routing, session configuration, and interruption handling for video calls.

### Exported Methods

#### `configureForCall(): Promise<{configured: bool, category: string, mode: string}>`

Configures audio session for VoIP with PlayAndRecord category and VoiceChat mode. Sets up observers for route changes and interruptions.

#### `setOutputRoute(route: 'speaker' | 'earpiece' | 'bluetooth'): Promise<{route: string, success: bool}>`

Routes audio output to specified device. Throws if Bluetooth requested but unavailable.

#### `getAvailableRoutes(): Promise<{available: string[], hasHeadphones: bool, hasBluetoothDevices: bool}>`

Returns list of available output routes and connection status.

#### `getCurrentRoute(): Promise<{current: string, outputs: Array<{port: string, name: string}>}>`

Returns currently active output route and all connected outputs.

#### `setSpeakerphone(enabled: bool): Promise<{speakerEnabled: bool, success: bool}>`

Toggles speakerphone mode.

### Events

- `onRouteChange` - Emitted when audio route changes (e.g., headphones unplugged)
- `onInterruption` - Emitted on audio interruption (incoming call, alarm, etc.)

## Installation

```bash
cd ios && pod install
```

Then add to your `Podfile`:

```ruby
pod 'ChalkReactNative', :path => '../packages/sdk-react-native/ios'
```

## Usage (React Native)

```typescript
import { NativeModules, NativeEventEmitter } from "react-native";

const AudioSession = NativeModules.AudioSessionModule;
const audioEmitter = new NativeEventEmitter(AudioSession);

// Configure for call
await AudioSession.configureForCall();

// Listen for route changes
audioEmitter.addListener("onRouteChange", (event) => {
  console.log("Route changed to:", event.route);
});

// Set output route
await AudioSession.setOutputRoute("speaker");

// Get available routes
const routes = await AudioSession.getAvailableRoutes();
```

## Notes

- All operations run on the main thread for safety
- Observers are properly cleaned up on module deallocation
- Supports modern Bluetooth audio devices (HFP, A2DP, LE)
- Compatible with iOS 13.0+
- Swift 5.0+
