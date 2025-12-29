# @chalk/react-native - Platform Setup Guide

Complete setup guide for integrating the Chalk React Native SDK with native iOS and Android platforms.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [iOS Setup](#ios-setup)
  - [Basic Permissions](#ios-basic-permissions)
  - [Background Audio](#ios-background-audio)
  - [Screen Sharing](#ios-screen-sharing)
  - [CallKit Integration](#ios-callkit-integration)
- [Android Setup](#android-setup)
  - [Basic Permissions](#android-basic-permissions)
  - [Background Audio](#android-background-audio)
  - [Screen Sharing](#android-screen-sharing)
  - [Foreground Service](#android-foreground-service)
- [Runtime Permissions](#runtime-permissions)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- React Native >= 0.70.0
- iOS 13.0+ / Android API 24+
- Xcode 14+ (for iOS)
- CocoaPods (for iOS)

---

## Installation

```bash
# Install the SDK and peer dependencies
bun add @chalk/react-native @chalk/core react-native-webrtc

# For screen sharing support (optional)
bun add @cloudflare/realtimekit-react-native

# iOS: Install pods
cd ios && pod install && cd ..
```

---

## iOS Setup

### iOS Basic Permissions

Add the following to your `ios/YourApp/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- Camera Permission -->
    <key>NSCameraUsageDescription</key>
    <string>$(PRODUCT_NAME) needs camera access for video calls</string>
    
    <!-- Microphone Permission -->
    <key>NSMicrophoneUsageDescription</key>
    <string>$(PRODUCT_NAME) needs microphone access for voice calls</string>
    
    <!-- Photo Library (for saving recordings locally) -->
    <key>NSPhotoLibraryAddUsageDescription</key>
    <string>$(PRODUCT_NAME) needs photo library access to save call recordings</string>
    
    <!-- Bluetooth (for Bluetooth headsets) -->
    <key>NSBluetoothAlwaysUsageDescription</key>
    <string>$(PRODUCT_NAME) needs Bluetooth access for wireless headsets</string>
    <key>NSBluetoothPeripheralUsageDescription</key>
    <string>$(PRODUCT_NAME) needs Bluetooth access for wireless headsets</string>
</dict>
</plist>
```

### iOS Background Audio

To allow audio to continue when the app is in the background (essential for calls):

#### 1. Add Background Modes to Info.plist

```xml
<key>UIBackgroundModes</key>
<array>
    <!-- Required: Audio playback/recording in background -->
    <string>audio</string>
    
    <!-- Required: VoIP calls -->
    <string>voip</string>
    
    <!-- Optional: For PushKit VoIP notifications -->
    <string>remote-notification</string>
    
    <!-- Optional: Fetch content in background -->
    <string>fetch</string>
</array>
```

#### 2. Enable in Xcode

1. Open your project in Xcode
2. Select your app target
3. Go to **Signing & Capabilities** tab
4. Click **+ Capability**
5. Add **Background Modes**
6. Check:
   - [x] Audio, AirPlay, and Picture in Picture
   - [x] Voice over IP
   - [x] Remote notifications (optional)

#### 3. Configure AVAudioSession in AppDelegate

Add to your `ios/YourApp/AppDelegate.mm` (or create a Swift file):

**Objective-C:**
```objc
#import <AVFoundation/AVFoundation.h>

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
    // Configure audio session for VoIP
    AVAudioSession *audioSession = [AVAudioSession sharedInstance];
    NSError *error = nil;
    
    [audioSession setCategory:AVAudioSessionCategoryPlayAndRecord
                  withOptions:AVAudioSessionCategoryOptionDefaultToSpeaker |
                              AVAudioSessionCategoryOptionAllowBluetooth |
                              AVAudioSessionCategoryOptionAllowBluetoothA2DP |
                              AVAudioSessionCategoryOptionMixWithOthers
                        error:&error];
    
    if (error) {
        NSLog(@"Error setting audio session category: %@", error);
    }
    
    [audioSession setMode:AVAudioSessionModeVoiceChat error:&error];
    if (error) {
        NSLog(@"Error setting audio session mode: %@", error);
    }
    
    [audioSession setActive:YES error:&error];
    if (error) {
        NSLog(@"Error activating audio session: %@", error);
    }
    
    // ... rest of your didFinishLaunchingWithOptions
    return [super application:application didFinishLaunchingWithOptions:launchOptions];
}
```

**Swift (if using Swift AppDelegate):**
```swift
import AVFoundation

func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    // Configure audio session for VoIP
    let audioSession = AVAudioSession.sharedInstance()
    do {
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
        )
        try audioSession.setActive(true)
    } catch {
        print("Failed to configure audio session: \(error)")
    }
    
    return true
}
```

### iOS Screen Sharing

Screen sharing on iOS requires a **Broadcast Upload Extension** that runs in a separate process.

#### 1. Create Broadcast Upload Extension

1. In Xcode, go to **File > New > Target**
2. Select **Broadcast Upload Extension**
3. Name it `ChalkScreenShare` (or your preferred name)
4. Choose your language (Swift recommended)

#### 2. Configure App Groups

Both your main app and the extension need to share data via App Groups:

1. Select your **main app target** in Xcode
2. Go to **Signing & Capabilities**
3. Add **App Groups** capability
4. Create a new group: `group.com.yourcompany.chalk.screenshare`

5. Repeat for the **ChalkScreenShare** extension target

#### 3. Update Extension's Info.plist

In `ios/ChalkScreenShare/Info.plist`:

```xml
<key>NSExtension</key>
<dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.broadcast-services-upload</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).SampleHandler</string>
    <key>RPBroadcastProcessMode</key>
    <string>RPBroadcastProcessModeSampleBuffer</string>
</dict>
```

#### 4. Implement SampleHandler.swift

Create/update `ios/ChalkScreenShare/SampleHandler.swift`:

```swift
import ReplayKit

class SampleHandler: RPBroadcastSampleHandler {
    
    private let appGroupIdentifier = "group.com.yourcompany.chalk.screenshare"
    
    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        // User has requested to start the broadcast
        // Set up connection to main app via App Groups
        
        let userDefaults = UserDefaults(suiteName: appGroupIdentifier)
        userDefaults?.set(true, forKey: "broadcastStarted")
        userDefaults?.synchronize()
        
        // Post notification to main app
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(center, CFNotificationName("com.chalk.screenshare.started" as CFString), nil, nil, true)
    }
    
    override func broadcastPaused() {
        // User has requested to pause the broadcast
    }
    
    override func broadcastResumed() {
        // User has requested to resume the broadcast
    }
    
    override func broadcastFinished() {
        // User has requested to finish the broadcast
        let userDefaults = UserDefaults(suiteName: appGroupIdentifier)
        userDefaults?.set(false, forKey: "broadcastStarted")
        userDefaults?.synchronize()
        
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(center, CFNotificationName("com.chalk.screenshare.stopped" as CFString), nil, nil, true)
    }
    
    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video:
            // Handle video sample buffer
            // Send to main app or directly to RealtimeKit
            handleVideoSample(sampleBuffer)
            
        case .audioApp:
            // Handle audio sample buffer for app audio
            handleAudioSample(sampleBuffer, isApp: true)
            
        case .audioMic:
            // Handle audio sample buffer for mic audio
            handleAudioSample(sampleBuffer, isApp: false)
            
        @unknown default:
            break
        }
    }
    
    private func handleVideoSample(_ sampleBuffer: CMSampleBuffer) {
        // Implementation: encode and send video frames
        // This typically involves:
        // 1. Converting CMSampleBuffer to CVPixelBuffer
        // 2. Encoding via VideoToolbox or passing to RealtimeKit
        // 3. Sending via shared memory/App Groups to main app
    }
    
    private func handleAudioSample(_ sampleBuffer: CMSampleBuffer, isApp: Bool) {
        // Implementation: encode and send audio frames
    }
}
```

#### 5. Update Podfile

Add to your `ios/Podfile`:

```ruby
target 'ChalkScreenShare' do
  pod 'react-native-webrtc', :path => '../node_modules/react-native-webrtc'
  # If using RealtimeKit
  # pod 'CloudflareRealtimeKit', :path => '../node_modules/@cloudflare/realtimekit-react-native'
end
```

Then run:
```bash
cd ios && pod install && cd ..
```

#### 6. Start Screen Share from React Native

```tsx
import { useScreenShare } from '@chalk/react-native';
import { NativeModules } from 'react-native';

function ScreenShareButton() {
  const { startScreenShare, stopScreenShare, isScreenSharing } = useScreenShare();

  const handlePress = async () => {
    if (isScreenSharing) {
      await stopScreenShare();
    } else {
      // On iOS, this will present the system broadcast picker
      await startScreenShare();
    }
  };

  return (
    <Button title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'} onPress={handlePress} />
  );
}
```

### iOS CallKit Integration

For a native phone call experience (incoming call UI, call history):

#### 1. Add CallKit Capability

In `ios/YourApp/Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
    <!-- ... existing modes ... -->
    <string>voip</string>
</array>
```

#### 2. Install CallKit Package

```bash
bun add react-native-callkeep
cd ios && pod install && cd ..
```

#### 3. Configure CallKeep

```tsx
import RNCallKeep from 'react-native-callkeep';

// Initialize CallKeep
RNCallKeep.setup({
  ios: {
    appName: 'Chalk',
    supportsVideo: true,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
  },
});

// Display incoming call
RNCallKeep.displayIncomingCall(
  callUUID,
  handle,
  callerName,
  'generic',
  true // hasVideo
);
```

---

## Android Setup

### Android Basic Permissions

Add to your `android/app/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    
    <!-- Basic Permissions -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    
    <!-- Camera & Microphone -->
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    
    <!-- Bluetooth Audio -->
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    
    <!-- Wake Lock (keep CPU awake during calls) -->
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    
    <!-- Vibration (for incoming calls) -->
    <uses-permission android:name="android.permission.VIBRATE" />
    
    <!-- Storage (for saving recordings) -->
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" 
                     android:maxSdkVersion="28" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" 
                     android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
    
    <!-- Foreground Service (for background calls) -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />
    
    <!-- Screen Capture (Android 14+) -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />
    
    <!-- POST_NOTIFICATIONS (Android 13+) -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    
    <!-- Hardware Features (optional, for Play Store filtering) -->
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />
    
    <application ...>
        <!-- ... your activities ... -->
    </application>
</manifest>
```

### Android Background Audio

To keep audio running when the app is backgrounded, use a Foreground Service.

#### 1. Create Foreground Service

Create `android/app/src/main/java/com/yourapp/CallService.kt`:

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
        const val ACTION_START = "com.yourapp.action.START_CALL"
        const val ACTION_STOP = "com.yourapp.action.STOP_CALL"
    }
    
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }
    
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startForegroundService()
            ACTION_STOP -> stopForegroundService()
        }
        return START_STICKY
    }
    
    override fun onBind(intent: Intent?): IBinder? = null
    
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Active Call",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows when you're in an active call"
                setShowBadge(false)
            }
            
            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }
    
    private fun startForegroundService() {
        val notification = createNotification()
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
    
    private fun stopForegroundService() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
    
    private fun createNotification(): Notification {
        // Intent to open app when notification tapped
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE
        )
        
        // Intent for "End Call" action
        val endCallIntent = Intent(this, CallService::class.java).apply {
            action = ACTION_STOP
        }
        val endCallPendingIntent = PendingIntent.getService(
            this,
            0,
            endCallIntent,
            PendingIntent.FLAG_IMMUTABLE
        )
        
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Chalk Call Active")
            .setContentText("Tap to return to call")
            .setSmallIcon(R.drawable.ic_call) // Create this icon
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .addAction(R.drawable.ic_call_end, "End Call", endCallPendingIntent)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
```

#### 2. Register Service in Manifest

Add to `AndroidManifest.xml` inside `<application>`:

```xml
<service
    android:name=".CallService"
    android:enabled="true"
    android:exported="false"
    android:foregroundServiceType="camera|microphone" />
```

#### 3. Create Native Module to Control Service

Create `android/app/src/main/java/com/yourapp/CallServiceModule.kt`:

```kotlin
package com.yourapp

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.*

class CallServiceModule(reactContext: ReactApplicationContext) : 
    ReactContextBaseJavaModule(reactContext) {
    
    override fun getName() = "CallServiceModule"
    
    @ReactMethod
    fun startCallService() {
        val intent = Intent(reactApplicationContext, CallService::class.java).apply {
            action = CallService.ACTION_START
        }
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactApplicationContext.startForegroundService(intent)
        } else {
            reactApplicationContext.startService(intent)
        }
    }
    
    @ReactMethod
    fun stopCallService() {
        val intent = Intent(reactApplicationContext, CallService::class.java).apply {
            action = CallService.ACTION_STOP
        }
        reactApplicationContext.startService(intent)
    }
}
```

#### 4. Register the Module

Create `android/app/src/main/java/com/yourapp/CallServicePackage.kt`:

```kotlin
package com.yourapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CallServicePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(CallServiceModule(reactContext))
    }
    
    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
```

Add to `MainApplication.kt`:

```kotlin
override fun getPackages(): List<ReactPackage> = PackageList(this).packages.apply {
    add(CallServicePackage())
}
```

#### 5. Use from React Native

```tsx
import { NativeModules, Platform } from 'react-native';

const { CallServiceModule } = NativeModules;

// Start foreground service when call begins
export function startBackgroundCall() {
  if (Platform.OS === 'android') {
    CallServiceModule?.startCallService();
  }
}

// Stop when call ends
export function stopBackgroundCall() {
  if (Platform.OS === 'android') {
    CallServiceModule?.stopCallService();
  }
}
```

### Android Screen Sharing

Android screen sharing uses MediaProjection API.

#### 1. Update Foreground Service

Modify `CallService.kt` to support screen capture:

```kotlin
// Update foregroundServiceType in startForegroundService()
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
    startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
    )
}
```

#### 2. Update Manifest

```xml
<service
    android:name=".CallService"
    android:enabled="true"
    android:exported="false"
    android:foregroundServiceType="camera|microphone|mediaProjection" />
```

#### 3. Request Screen Capture Permission

The SDK handles this internally, but you need to ensure the Activity result is forwarded:

```kotlin
// In your MainActivity.kt
override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    // react-native-webrtc handles the MediaProjection result internally
}
```

### Android Foreground Service

Already covered in [Background Audio](#android-background-audio) section.

---

## Runtime Permissions

### Using the Built-in Permission Request

The SDK automatically requests camera and microphone permissions. However, for better UX, you should request permissions before joining a call:

```tsx
import { Platform, PermissionsAndroid, Alert, Linking } from 'react-native';
import { useCallback, useState } from 'react';

export type PermissionStatus = 'granted' | 'denied' | 'blocked' | 'unavailable';

export interface PermissionsState {
  camera: PermissionStatus;
  microphone: PermissionStatus;
  notifications: PermissionStatus;
}

export function usePermissions() {
  const [permissions, setPermissions] = useState<PermissionsState>({
    camera: 'unavailable',
    microphone: 'unavailable',
    notifications: 'unavailable',
  });

  const checkPermissions = useCallback(async (): Promise<PermissionsState> => {
    if (Platform.OS === 'android') {
      const camera = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.CAMERA
      );
      const microphone = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
      );
      
      const state: PermissionsState = {
        camera: camera ? 'granted' : 'denied',
        microphone: microphone ? 'granted' : 'denied',
        notifications: 'granted', // Check POST_NOTIFICATIONS on Android 13+
      };
      
      setPermissions(state);
      return state;
    }
    
    // iOS permissions are checked at request time
    return permissions;
  }, [permissions]);

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      try {
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ]);

        const cameraGranted = 
          results[PermissionsAndroid.PERMISSIONS.CAMERA] === 'granted';
        const micGranted = 
          results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted';

        setPermissions({
          camera: cameraGranted ? 'granted' : 'denied',
          microphone: micGranted ? 'granted' : 'denied',
          notifications: 'granted',
        });

        if (!cameraGranted || !micGranted) {
          handlePermissionDenied(cameraGranted, micGranted);
          return false;
        }

        return true;
      } catch (error) {
        console.error('Permission request error:', error);
        return false;
      }
    }

    // iOS: Permissions are requested automatically by react-native-webrtc
    // The system will show the permission dialog when getUserMedia is called
    return true;
  }, []);

  const openSettings = useCallback(() => {
    Linking.openSettings();
  }, []);

  return {
    permissions,
    checkPermissions,
    requestPermissions,
    openSettings,
  };
}

function handlePermissionDenied(cameraGranted: boolean, micGranted: boolean) {
  const missing: string[] = [];
  if (!cameraGranted) missing.push('Camera');
  if (!micGranted) missing.push('Microphone');

  Alert.alert(
    'Permissions Required',
    `Chalk needs ${missing.join(' and ')} access to make video calls. Please grant permissions in Settings.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open Settings', onPress: () => Linking.openSettings() },
    ]
  );
}
```

### Pre-Call Permission Check Component

```tsx
import { View, Text, Button, StyleSheet } from 'react-native';
import { usePermissions } from './usePermissions';
import { useEffect, useState } from 'react';

interface PermissionGateProps {
  children: React.ReactNode;
  onPermissionDenied?: () => void;
}

export function PermissionGate({ children, onPermissionDenied }: PermissionGateProps) {
  const { permissions, checkPermissions, requestPermissions, openSettings } = usePermissions();
  const [isChecking, setIsChecking] = useState(true);
  const [hasPermissions, setHasPermissions] = useState(false);

  useEffect(() => {
    checkPermissions().then((state) => {
      setIsChecking(false);
      setHasPermissions(
        state.camera === 'granted' && state.microphone === 'granted'
      );
    });
  }, [checkPermissions]);

  const handleRequestPermissions = async () => {
    const granted = await requestPermissions();
    setHasPermissions(granted);
    if (!granted) {
      onPermissionDenied?.();
    }
  };

  if (isChecking) {
    return (
      <View style={styles.container}>
        <Text>Checking permissions...</Text>
      </View>
    );
  }

  if (!hasPermissions) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Camera & Microphone Access</Text>
        <Text style={styles.description}>
          Chalk needs access to your camera and microphone to make video calls.
        </Text>
        
        <View style={styles.permissionRow}>
          <Text>Camera: </Text>
          <Text style={permissions.camera === 'granted' ? styles.granted : styles.denied}>
            {permissions.camera}
          </Text>
        </View>
        
        <View style={styles.permissionRow}>
          <Text>Microphone: </Text>
          <Text style={permissions.microphone === 'granted' ? styles.granted : styles.denied}>
            {permissions.microphone}
          </Text>
        </View>
        
        <Button title="Grant Permissions" onPress={handleRequestPermissions} />
        
        {(permissions.camera === 'blocked' || permissions.microphone === 'blocked') && (
          <Button title="Open Settings" onPress={openSettings} />
        )}
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  description: {
    textAlign: 'center',
    marginBottom: 20,
    color: '#666',
  },
  permissionRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  granted: {
    color: 'green',
    fontWeight: 'bold',
  },
  denied: {
    color: 'red',
    fontWeight: 'bold',
  },
});
```

### Usage Example

```tsx
import { ChalkProvider } from '@chalk/react-native';
import { PermissionGate } from './PermissionGate';

export default function App() {
  return (
    <PermissionGate onPermissionDenied={() => console.log('User denied permissions')}>
      <ChalkProvider token="your-jwt-token">
        <CallScreen />
      </ChalkProvider>
    </PermissionGate>
  );
}
```

---

## Troubleshooting

### iOS Issues

#### "Camera/Microphone permission denied" but Info.plist is correct

1. Clean build: `cd ios && rm -rf build && pod install && cd ..`
2. Reset simulator: Device > Erase All Content and Settings
3. Delete app from device and reinstall
4. Check that usage descriptions are in the **correct target's** Info.plist

#### Background audio stops after ~30 seconds

1. Verify `UIBackgroundModes` includes both `audio` and `voip`
2. Ensure AVAudioSession is configured correctly in AppDelegate
3. Check that no other code is deactivating the audio session

#### Screen sharing extension not showing in picker

1. Verify the extension target is in the same App Group
2. Ensure the extension is signed with the same team
3. Check RPBroadcastProcessMode is set correctly

### Android Issues

#### "Permission denied" even after granting

1. Check targetSdkVersion - Android 14+ requires specific foreground service types
2. Verify all permissions are in AndroidManifest.xml
3. Check runtime permission requests are being made

#### Foreground service notification not appearing

1. Ensure NotificationChannel is created (required for Android 8+)
2. Check POST_NOTIFICATIONS permission on Android 13+
3. Verify service is started with `startForegroundService()` on Android 8+

#### Screen capture fails on Android 14+

1. Add `FOREGROUND_SERVICE_MEDIA_PROJECTION` permission
2. Update foregroundServiceType to include `mediaProjection`
3. Ensure MediaProjection is requested after foreground service starts

### General Issues

#### No audio/video after joining

1. Check permissions are granted (both platform and runtime)
2. Verify WebSocket connection is established
3. Check console logs for RealtimeKit errors
4. Ensure device has working camera/microphone

#### Echo or feedback during calls

1. Verify `echoCancellation` is enabled in audio constraints
2. Use `AudioSession` component with proper configuration
3. On iOS, ensure `AVAudioSessionModeVoiceChat` is set

---

## Additional Resources

- [react-native-webrtc Documentation](https://github.com/react-native-webrtc/react-native-webrtc)
- [Apple AVAudioSession Programming Guide](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [Android MediaProjection Guide](https://developer.android.com/guide/topics/media/av-capture)
- [iOS ReplayKit Documentation](https://developer.apple.com/documentation/replaykit)
- [Cloudflare RealtimeKit](https://developers.cloudflare.com/calls/)

---

## Support

For SDK-specific issues, please open an issue on the Chalk GitHub repository.

For platform-specific issues (iOS/Android configuration), refer to the respective platform documentation or react-native-webrtc issues.
