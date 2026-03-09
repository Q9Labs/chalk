# @chalk/react-native - Platform Setup

Platform-specific configuration for iOS and Android.

## Prerequisites

- React Native >= 0.70.0
- iOS 13.0+ / Android API 24+
- Xcode 14+ (iOS)
- CocoaPods (iOS)

## Installation

```bash
bun add @chalk/react-native @chalk/core react-native-webrtc
cd ios && pod install && cd ..
```

---

## iOS Setup

### Basic Permissions

Add to `ios/YourApp/Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>$(PRODUCT_NAME) needs camera for video calls</string>
<key>NSMicrophoneUsageDescription</key>
<string>$(PRODUCT_NAME) needs microphone for calls</string>
<key>NSBluetoothAlwaysUsageDescription</key>
<string>$(PRODUCT_NAME) needs Bluetooth for wireless headsets</string>
```

### Background Audio

**1. Enable Background Modes** - Add to `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
    <string>voip</string>
</array>
```

Or in Xcode: **Signing & Capabilities** → **+ Capability** → **Background Modes** → Check:

- ✓ Audio, AirPlay, and Picture in Picture
- ✓ Voice over IP

**2. Configure AVAudioSession** - Add to `AppDelegate.mm`:

```objc
#import <AVFoundation/AVFoundation.h>

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    AVAudioSession *audioSession = [AVAudioSession sharedInstance];
    NSError *error = nil;

    [audioSession setCategory:AVAudioSessionCategoryPlayAndRecord
                  withOptions:AVAudioSessionCategoryOptionDefaultToSpeaker |
                              AVAudioSessionCategoryOptionAllowBluetooth |
                              AVAudioSessionCategoryOptionAllowBluetoothA2DP
                        error:&error];
    [audioSession setMode:AVAudioSessionModeVoiceChat error:&error];
    [audioSession setActive:YES error:&error];

    return [super application:application didFinishLaunchingWithOptions:launchOptions];
}
```

### Screen Sharing

**1. Create Broadcast Upload Extension:**

- Xcode → **File > New > Target** → **Broadcast Upload Extension**
- Name: `ChalkScreenShare`

**2. Configure App Groups:**

- Main app + extension: **Signing & Capabilities** → **+ App Groups**
- Create: `group.com.yourcompany.chalk.screenshare`

**3. Implement SampleHandler** - See full code in original SETUP.md or use template

**4. Update Podfile:**

```ruby
target 'ChalkScreenShare' do
  pod 'react-native-webrtc', :path => '../node_modules/react-native-webrtc'
end
```

**5. Usage:**

```tsx
import { useScreenShare } from "@chalk/react-native";

const { startScreenShare, stopScreenShare, isScreenSharing } = useScreenShare();
```

---

## Android Setup

### Basic Permissions

Add to `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

### Background Audio - Foreground Service

**1. Create CallService.kt:**

```kotlin
package com.yourapp

import android.app.*
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class CallService : Service() {
    companion object {
        const val CHANNEL_ID = "chalk_call_channel"
        const val NOTIFICATION_ID = 1001
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, createNotification())
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "Active Call", NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Chalk Call Active")
            .setSmallIcon(R.drawable.ic_call)
            .setOngoing(true)
            .build()
    }
}
```

**2. Register in AndroidManifest.xml:**

```xml
<service
    android:name=".CallService"
    android:foregroundServiceType="camera|microphone" />
```

**3. Create Native Module** - CallServiceModule.kt to start/stop service from React Native

**4. Usage:**

```tsx
import { NativeModules } from "react-native";

NativeModules.CallServiceModule?.startCallService();
NativeModules.CallServiceModule?.stopCallService();
```

### Screen Sharing

Update `CallService` foregroundServiceType:

```xml
android:foregroundServiceType="camera|microphone|mediaProjection"
```

---

## Runtime Permissions

### Request Permissions Hook

```tsx
import { PermissionsAndroid, Platform } from "react-native";

export function usePermissions() {
  const requestPermissions = async () => {
    if (Platform.OS === "android") {
      const results = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.CAMERA, PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]);

      return results["android.permission.CAMERA"] === "granted" && results["android.permission.RECORD_AUDIO"] === "granted";
    }
    return true; // iOS: auto-requested by getUserMedia
  };

  return { requestPermissions };
}
```

---

## Troubleshooting

| Issue                                     | Solution                                                          |
| ----------------------------------------- | ----------------------------------------------------------------- |
| iOS: Permission denied despite Info.plist | Clean build: `cd ios && rm -rf build && pod install`              |
| iOS: Background audio stops               | Verify `UIBackgroundModes` + AVAudioSession config                |
| Android: Foreground notification missing  | Create NotificationChannel (Android 8+), check POST_NOTIFICATIONS |
| Android: Screen capture fails (14+)       | Add FOREGROUND_SERVICE_MEDIA_PROJECTION permission                |
| No audio/video after join                 | Check permissions granted, WebSocket connected, device hardware   |

---

## Resources

- [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc)
- [AVAudioSession Guide](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [Android MediaProjection](https://developer.android.com/guide/topics/media/av-capture)
- [iOS ReplayKit](https://developer.apple.com/documentation/replaykit)
