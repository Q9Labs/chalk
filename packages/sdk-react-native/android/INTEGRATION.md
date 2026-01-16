# Android Integration Guide

## Project Setup

### 1. Link the Native Module

In your Android project's `settings.gradle`:

```gradle
include ':chalk'
project(':chalk').projectDir = new File(rootProject.projectDir, '../node_modules/@q9labs/chalk-react-native/android')
```

### 2. Add Dependency

In your app's `build.gradle`:

```gradle
dependencies {
  implementation project(':chalk')
  // Alternative: if using GitHub Packages with proper auth
  // implementation '@q9labs:chalk-react-native:0.0.17'
}
```

### 3. Register the Package

In `android/app/src/main/java/.../MainApplication.java`:

```java
import com.q9labs.chalk.ChalkPackage;

public class MainApplication extends ReactApplication {

  private final ReactNativeHost mReactNativeHost = new ReactNativeHost(this) {
    @Override
    public boolean getUseDeveloperSupport() {
      return BuildConfig.DEBUG;
    }

    @Override
    protected List<ReactPackage> getPackages() {
      List<ReactPackage> packages = new PackageList(this).getPackages();
      packages.add(new ChalkPackage());  // Add this line
      return packages;
    }

    @Override
    protected String getJSMainModuleFile() {
      return "index";
    }
  };

  // ... rest of implementation
}
```

### 4. Request Runtime Permissions (API 31+)

For Android 12 (API 31) and above, add runtime permission requests in your activity:

```java
import android.Manifest;
import android.content.pm.PackageManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

public class MainActivity extends ReactActivity {

  private static final int PERMISSION_REQUEST_CODE = 100;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
          != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(
          this,
          new String[]{Manifest.permission.BLUETOOTH_CONNECT},
          PERMISSION_REQUEST_CODE
        );
      }
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode == PERMISSION_REQUEST_CODE) {
      // Handle permission result
      if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
        // Permission granted
      }
    }
  }
}
```

### 5. Update AndroidManifest.xml (App Level)

Ensure your app's manifest includes required permissions:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
  package="com.example.app">

  <!-- Required for Chalk audio management -->
  <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
  <uses-permission android:name="android.permission.BLUETOOTH" />
  <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

  <!-- Your other permissions and activities -->

</manifest>
```

## JavaScript Integration

### Import the Module

```typescript
import { NativeModules, DeviceEventEmitter } from 'react-native';

const { AudioSessionModule } = NativeModules;

// Or in your SDK wrapper
export const audioSession = AudioSessionModule;
```

### Create a Hook

```typescript
import { useEffect, useCallback } from 'react';
import { NativeModules, DeviceEventEmitter } from 'react-native';

const { AudioSessionModule } = NativeModules;

export function useAudioSession() {
  useEffect(() => {
    // Configure audio when component mounts
    AudioSessionModule.configureForCall()
      .catch(error => console.error('Failed to configure audio', error));

    return () => {
      // Cleanup handled by native module
    };
  }, []);

  const setRoute = useCallback(async (route: 'speaker' | 'earpiece' | 'bluetooth') => {
    try {
      await AudioSessionModule.setOutputRoute(route);
    } catch (error) {
      console.error(`Failed to set audio route to ${route}`, error);
    }
  }, []);

  const getAvailableRoutes = useCallback(async () => {
    try {
      return await AudioSessionModule.getAvailableRoutes();
    } catch (error) {
      console.error('Failed to get available routes', error);
      return [];
    }
  }, []);

  const getCurrentRoute = useCallback(async () => {
    try {
      return await AudioSessionModule.getCurrentRoute();
    } catch (error) {
      console.error('Failed to get current route', error);
      return null;
    }
  }, []);

  return {
    setRoute,
    getAvailableRoutes,
    getCurrentRoute,
  };
}
```

### Listen to Events

```typescript
import { useEffect } from 'react';
import { DeviceEventEmitter } from 'react-native';

export function useAudioRouteListener(onRouteChange: (route: string) => void) {
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener(
      'audioRouteChanged',
      (event) => onRouteChange(event.route)
    );

    return () => subscription.remove();
  }, [onRouteChange]);
}

export function useAudioFocusListener(onFocusChange: (state: string) => void) {
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener(
      'audioFocusChanged',
      (event) => onFocusChange(event.focusState)
    );

    return () => subscription.remove();
  }, [onFocusChange]);
}
```

## Build & Test

### Build the App

```bash
cd your-react-native-app
npm run android  # or yarn android / bun run android
```

### Debug

Enable logging in Android Studio:
1. Connect device or start emulator
2. Run `adb logcat | grep AudioSessionModule` in terminal
3. Check logs while testing audio routes

## Troubleshooting

### Module Not Found Error

**Error:** `NativeModules.AudioSessionModule is undefined`

**Solution:**
1. Verify ChalkPackage is registered in MainApplication
2. Rebuild: `./gradlew clean && npm run android`
3. Clear Metro cache: `npm start -- --reset-cache`

### Bluetooth Not Working

**Error:** `BLUETOOTH_NOT_AVAILABLE` when calling `setOutputRoute('bluetooth')`

**Solution:**
1. Ensure Bluetooth permission is granted (runtime on API 31+)
2. Pair device via Settings > Bluetooth
3. Check if device supports Bluetooth SCO
4. Verify `canStartBluetoothSco()` conditions in code

### Permission Denied

**Error:** `SecurityException` when requesting audio focus

**Solution:**
1. Add permissions to app's AndroidManifest.xml
2. Request BLUETOOTH_CONNECT at runtime on API 31+
3. Verify app has permissions via Settings > Apps

### Gradle Sync Failures

**Error:** Kotlin plugin or React Native version mismatch

**Solution:**
1. Verify Kotlin version in `android/build.gradle`
2. Ensure React Native version matches in dependencies
3. Run `./gradlew --refresh-dependencies`

## Advanced Configuration

### Custom Gradle Properties

Add to `android/gradle.properties`:

```properties
# Kotlin
kotlin.code.style=official
kotlin.incremental=true

# Gradle
org.gradle.jvmargs=-Xmx4g
org.gradle.parallel=true
org.gradle.daemon=true
```

### Proguard Rules

If using ProGuard or R8, add to `android/app/proguard-rules.pro`:

```proguard
# Chalk AudioSessionModule
-keep class com.q9labs.chalk.** { *; }
-keep class com.facebook.react.bridge.** { *; }

# Preserve Kotlin metadata
-keepattributes *Annotation*
-keep class kotlin.** { *; }
-keep interface kotlin.** { *; }
```

## Support

For issues or questions:
1. Check Android logcat output
2. Verify permissions are granted
3. Test with actual device (emulator Bluetooth support is limited)
4. Review native module logs for detailed error messages
