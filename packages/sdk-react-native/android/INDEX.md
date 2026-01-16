# Android Module Index

Quick reference guide for the Chalk Android native module.

## Documentation

- **[README.md](./README.md)** - Complete feature overview and API documentation
- **[INTEGRATION.md](./INTEGRATION.md)** - Step-by-step integration guide for Android projects
- **[IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)** - Technical implementation details and testing checklist

## Source Files

### Core Implementation

- **[build.gradle](./build.gradle)** - Gradle build configuration
  - Kotlin 1.9.22 setup
  - Android SDK targeting (min 24, target 34)
  - Dependencies configuration

- **[src/main/AndroidManifest.xml](./src/main/AndroidManifest.xml)** - Android manifest
  - Required permissions declaration
  - Module metadata

- **[src/main/java/com/q9labs/chalk/ChalkPackage.kt](./src/main/java/com/q9labs/chalk/ChalkPackage.kt)** - React Native package
  - ReactPackage implementation
  - Module registration (18 lines)

- **[src/main/java/com/q9labs/chalk/AudioSessionModule.kt](./src/main/java/com/q9labs/chalk/AudioSessionModule.kt)** - Core native module (247 lines)
  - Audio focus management
  - Output routing (speaker, earpiece, Bluetooth)
  - Event emission
  - Resource cleanup

## Quick Start

### For Android Developers

1. Read [INTEGRATION.md](./INTEGRATION.md) - Complete setup guide
2. Copy `android/` directory to your React Native app
3. Update `settings.gradle` and app `build.gradle`
4. Register `ChalkPackage` in `MainApplication.java`
5. Request Bluetooth permissions (API 31+)

### For JavaScript Developers

1. Read [README.md](./README.md) - JavaScript API reference
2. Import `NativeModules` from React Native
3. Call `AudioSessionModule.configureForCall()` when starting a call
4. Use `setOutputRoute()` to change audio routing
5. Listen to `audioRouteChanged` events for route changes

## API Reference

### Methods (7 total)

```javascript
// Configure audio session for VoIP
configureForCall(): Promise<boolean>

// Route audio to speaker/earpiece/bluetooth
setOutputRoute(route: 'speaker' | 'earpiece' | 'bluetooth'): Promise<boolean>

// Get available audio routes
getAvailableRoutes(): Promise<string[]>

// Get current audio route
getCurrentRoute(): Promise<string>

// Toggle speakerphone
setSpeakerphone(enabled: boolean): Promise<boolean>

// Start Bluetooth audio
startBluetoothSco(): Promise<boolean>

// Stop Bluetooth audio
stopBluetoothSco(): Promise<boolean>
```

### Events (2 types)

```javascript
// Emitted when audio route changes
DeviceEventEmitter.addListener('audioRouteChanged', (event) => {
  console.log(event.route); // 'speaker', 'earpiece', 'bluetooth', 'wired'
});

// Emitted when audio focus changes
DeviceEventEmitter.addListener('audioFocusChanged', (event) => {
  // event.focusState: 'gained', 'lost', 'lostTransient', 'lostTransientCanDuck'
});
```

## Key Features

- **Audio Focus** - Modern AudioFocusRequest (API 26+) with legacy fallback
- **VoIP Mode** - Optimized audio configuration (MODE_IN_COMMUNICATION)
- **Bluetooth** - Full SCO support with availability checking
- **Events** - Real-time route and focus change notifications
- **Error Handling** - Promise-based error reporting with descriptive codes
- **Cleanup** - Proper resource management on destroy

## Requirements

| Component | Requirement |
|-----------|-------------|
| Min SDK | 24 (Android 7.0) |
| Target SDK | 34 (Android 14) |
| Kotlin | 1.9.22+ |
| React Native | 0.70.0+ |
| Java | 17 |

## Permissions

Required in `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
```

**Note:** `BLUETOOTH_CONNECT` requires runtime permission on API 31+

## Common Tasks

### Initialize Audio on Call Start

```javascript
import { NativeModules } from 'react-native';

const { AudioSessionModule } = NativeModules;

// In your call component
useEffect(() => {
  AudioSessionModule.configureForCall()
    .catch(error => console.error('Audio config failed', error));
}, []);
```

### Switch to Speaker

```javascript
await AudioSessionModule.setOutputRoute('speaker');
```

### Check Available Routes

```javascript
const routes = await AudioSessionModule.getAvailableRoutes();
// routes: ['speaker', 'earpiece', 'bluetooth']
```

### Listen to Route Changes

```javascript
import { DeviceEventEmitter } from 'react-native';

DeviceEventEmitter.addListener('audioRouteChanged', (event) => {
  setCurrentRoute(event.route);
});
```

## Troubleshooting

### Bluetooth Not Available
- Verify device is paired in Settings
- Check runtime permissions on API 31+
- Bluetooth SCO availability is device-specific

### No Sound
- Verify `configureForCall()` was called
- Check volume is not muted
- Verify audio route is correctly set

### Module Not Found
- Confirm ChalkPackage is registered in MainApplication
- Rebuild: `./gradlew clean && npm run android`

See [INTEGRATION.md](./INTEGRATION.md) for detailed troubleshooting.

## File Organization

```
android/
├── build.gradle                       # Build configuration
├── src/main/
│   ├── AndroidManifest.xml            # Manifest & permissions
│   └── java/com/q9labs/chalk/
│       ├── ChalkPackage.kt            # Package definition
│       └── AudioSessionModule.kt      # Core implementation
├── README.md                          # Full documentation
├── INTEGRATION.md                     # Integration guide
├── IMPLEMENTATION_SUMMARY.md          # Technical summary
└── INDEX.md                           # This file
```

## Support

For issues:
1. Check logcat: `adb logcat | grep AudioSessionModule`
2. Review [INTEGRATION.md](./INTEGRATION.md) troubleshooting section
3. Verify permissions and module registration
4. Test on physical device (Bluetooth support limited on emulator)

## Version Info

- Module: @q9labs/chalk-react-native v0.0.17
- Created: January 15, 2026
- Kotlin: 1.9.22
- Target Android: API 34 (Android 14)
- Min Android: API 24 (Android 7.0)

## Next Steps

1. **Start:** Read [INTEGRATION.md](./INTEGRATION.md)
2. **Integrate:** Follow setup steps in your React Native project
3. **Test:** Verify audio routing on physical device
4. **Deploy:** Include in app build configuration

---

Last updated: January 15, 2026
