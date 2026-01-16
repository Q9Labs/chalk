# Chalk Android Native Module

Native Android module for @q9labs/chalk-react-native providing audio session management and device routing for video conferencing.

## Structure

```
android/
├── build.gradle                          # Module build configuration
├── src/main/
│   ├── AndroidManifest.xml               # Permissions and module metadata
│   ├── java/com/q9labs/chalk/
│   │   ├── ChalkPackage.kt               # React Native package definition
│   │   └── AudioSessionModule.kt         # Native audio management
│   └── res/                              # Resource directory (future use)
└── README.md                             # This file
```

## Features

### AudioSessionModule

Native module providing VoIP-optimized audio management:

- **Audio Focus Management** - Requests audio focus with VoIP priority (API 26+ with AudioFocusRequest)
- **Output Routing** - Switch between speaker, earpiece, and Bluetooth
- **Device Detection** - Query available audio routes
- **Bluetooth SCO** - Start/stop Bluetooth audio streaming
- **Event Emission** - Broadcast route changes and focus events to JavaScript

## Integration

### 1. Register in MainApplication.java

```java
import com.q9labs.chalk.ChalkPackage;

public class MainApplication extends ReactApplication {
  @Override
  protected List<ReactPackage> getPackages() {
    return Arrays.asList(
      new MainReactPackage(),
      new ChalkPackage()  // Add here
    );
  }
}
```

### 2. Link in app/build.gradle

```gradle
dependencies {
  implementation project(':chalk')
  // or from GitHub Packages:
  // implementation '@q9labs:chalk-react-native:@latest'
}
```

### 3. settings.gradle

```gradle
include ':chalk'
project(':chalk').projectDir = new File(rootProject.projectDir, '../node_modules/@q9labs/chalk-react-native/android')
```

## JavaScript API

### Configure Audio for Call

```javascript
import { NativeModules } from 'react-native';

const { AudioSessionModule } = NativeModules;

// Request audio focus and set VoIP mode
AudioSessionModule.configureForCall()
  .then(() => console.log('Audio configured'))
  .catch(e => console.error(e));
```

### Output Routing

```javascript
// Route to speaker
AudioSessionModule.setOutputRoute('speaker')
  .then(() => console.log('Audio routed to speaker'))
  .catch(e => console.error(e));

// Route to earpiece
AudioSessionModule.setOutputRoute('earpiece');

// Route to Bluetooth
AudioSessionModule.setOutputRoute('bluetooth')
  .catch(e => console.error('Bluetooth not available'));
```

### Query Routes

```javascript
// Get available routes
AudioSessionModule.getAvailableRoutes()
  .then(routes => console.log(routes)) // ['speaker', 'earpiece', 'bluetooth']
  .catch(e => console.error(e));

// Get current route
AudioSessionModule.getCurrentRoute()
  .then(route => console.log(route)) // 'speaker'
  .catch(e => console.error(e));
```

### Bluetooth Control

```javascript
// Start Bluetooth SCO (Synchronous Connection Oriented)
AudioSessionModule.startBluetoothSco()
  .then(() => console.log('Bluetooth SCO started'))
  .catch(e => console.error('Bluetooth unavailable'));

// Stop Bluetooth SCO
AudioSessionModule.stopBluetoothSco();
```

### Listen to Events

```javascript
import { DeviceEventEmitter } from 'react-native';

// Route change events
DeviceEventEmitter.addListener('audioRouteChanged', (e) => {
  console.log('Route changed to:', e.route);
});

// Audio focus change events
DeviceEventEmitter.addListener('audioFocusChanged', (e) => {
  console.log('Focus state:', e.focusState);
  // 'gained', 'lost', 'lostTransient', 'lostTransientCanDuck'
});
```

## Permissions

The following permissions are declared in AndroidManifest.xml:

```xml
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
```

Note: `BLUETOOTH_CONNECT` (API 31+) requires runtime permission on Android 12+.

## Implementation Details

### AudioFocusRequest (API 26+)

For API 26 and higher, uses modern AudioFocusRequest API with proper AudioAttributes:

```kotlin
val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
  .setAudioAttributes(
    AudioAttributes.Builder()
      .setUsage(USAGE_VOICE_COMMUNICATION)
      .setContentType(CONTENT_TYPE_SPEECH)
      .build()
  )
  .setOnAudioFocusChangeListener { /* handle */ }
  .build()
```

### VoIP Mode

Sets `MODE_IN_COMMUNICATION` for optimal voice quality:

```kotlin
audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
```

### Bluetooth SCO

Handles Bluetooth audio streaming with proper availability checks:

```kotlin
if (audioManager.isBluetoothScoAvailableOffCall || audioManager.isBluetoothA2dpOn) {
  audioManager.startBluetoothSco()
}
```

### Cleanup

Releases audio focus and restores normal audio mode on destroy:

```kotlin
override fun onCatalystInstanceDestroy() {
  audioManager.abandonAudioFocus(request)
  audioManager.mode = AudioManager.MODE_NORMAL
}
```

## Compatibility

- **Minimum SDK**: 24 (Android 7.0)
- **Target SDK**: 34 (Android 14)
- **Kotlin**: 1.9.22
- **React Native**: 0.70.0+

## Testing

### Manual Testing Checklist

- [ ] Verify audio focus is requested on call init
- [ ] Test speaker/earpiece switching
- [ ] Test Bluetooth pairing and audio routing
- [ ] Verify events are emitted on route changes
- [ ] Test cleanup on app dismiss
- [ ] Verify behavior on audio focus loss
- [ ] Test with actual device (permissions required)

## Troubleshooting

### Bluetooth Not Available

Ensure:
- Bluetooth device is paired and connected
- App has `BLUETOOTH` and `BLUETOOTH_CONNECT` permissions (request at runtime on API 31+)
- `isBluetoothScoAvailableOffCall` returns true

### Audio Focus Loss

Listen to `audioFocusChanged` events to handle interruptions (notifications, calls, etc.)

### No Sound During Call

Verify:
- `configureForCall()` was called
- Audio mode is `MODE_IN_COMMUNICATION`
- Volume is not muted (check with `audioManager.ringerMode`)
- Device route is correctly set

## License

Same as Chalk SDK - see root LICENSE
