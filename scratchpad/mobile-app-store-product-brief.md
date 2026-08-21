# Chalk mobile app: factual store-research brief

Scope: current repository evidence for `apps/mobile`, the React Native SDK it uses, `product.yaml`, the root README and changelog, and mobile whiteboard docs. This is a product brief for a copywriter, not store copy. Repository evidence does not prove that an app is currently published or that every code path has passed a real-device release test.

## 1) App name, package/bundle ID, platforms, and tech stack

- **App name:** Chalk. Expo config sets `name: "Chalk"`; the iOS display name is also `Chalk`. Source: `apps/mobile/app.config.ts:21-27`, `apps/mobile/ios/Chalk/Info.plist:8-12`.
- **JavaScript package:** `@q9labsai/chalk-mobile`, marked private. Source: `apps/mobile/package.json:2-5`.
- **Android application ID:** `ai.q9labs.chalk.mobile`. Source: `apps/mobile/app.config.ts:60-61`, `apps/mobile/.gplay/config.yaml:4`.
- **iOS bundle ID:** `ai.q9labs.chalk.mobile`. The iOS screen-sharing extension uses `ai.q9labs.chalk.mobile.screenshare`. Source: `apps/mobile/app.config.ts:50-57`, `apps/mobile/ios/Chalk/Info.plist:72-73`, `apps/mobile/ios/ChalkScreenShare/Info.plist:5-10`.
- **Platforms with release surfaces:** Android and iOS. The repo has Android Gradle release tasks and an iOS Xcode project, plus changelog language describing “production Android and iOS release surfaces.” Source: `apps/mobile/package.json:17-21`, `apps/mobile/ios/Chalk.xcodeproj`, `CHANGELOG.md:17-22`.
- **Do not list as shipped platforms:** macOS and tvOS have platform branches in the shared React Native SDK, but the mobile app’s release configuration and iOS plist target iPhone/iPad, and no macOS/tvOS store-release configuration was found. Source: `sdks/typescript/react-native/src/components/NativeMeetingRoom.tsx`, `apps/mobile/ios/Chalk/Info.plist:47-48`.
- **Stack:** Expo 55, React Native 0.83.2, React 19.2.7, TypeScript, native Kotlin/Swift projects, `@cloudflare/react-native-webrtc`, Chalk’s TypeScript client and React Native SDK, Expo SecureStore, AsyncStorage, Expo Clipboard, Document Picker, File System, Crypto, and React Native WebView. Source: `apps/mobile/package.json:27-56`, `apps/mobile/android/app/src/main/java/ai/q9labs/chalk/mobile`, `apps/mobile/ios/Chalk`, `sdks/typescript/react-native/README.md:3-22`.

The checked-in metadata is inconsistent: Expo and Android config say version `2.0.0` and build/version code `28`, while the checked-in iOS plist says `1.0.1` and build `19`. A store submission should use the release artifact’s resolved metadata, not assume these files agree. Source: `apps/mobile/app.config.ts:24-57`, `apps/mobile/android/app/build.gradle:8-10`, `apps/mobile/ios/Chalk/Info.plist:19-42`.

## 2) What the app does, the user problem, and target user

Chalk is a mobile video-meeting client. A person can create a meeting, name it optionally, enter a pre-join lobby, choose microphone/camera state, and join as host, or paste/open a Chalk invite link and join as a participant. The app accepts Chalk universal/deep links from `chalkmeet.com` and `chalk.q9labs.ai`, and it can suggest a valid invite link found in the clipboard. Source: `apps/mobile/src/screens/HomeScreen.shared.tsx:26-115`, `sdks/typescript/react-native/src/components/NativeVideoConference.tsx:90-163`, `apps/mobile/app.config.ts:65-80`.

The core problem is joining or hosting a live Chalk room from a phone or tablet without switching to a desktop browser. The most defensible target user is an invited meeting participant or a host who needs mobile access to an invite-based Chalk meeting. The code has no sign-in or account-creation screen, and the meeting flow uses an invite token or broker-created client session; this supports an account-free observed flow, but it is not evidence of a universal account policy outside this app. Source: `apps/mobile/src/lib/chalk.ts:40-78`, `apps/mobile/src/meeting/MobileMeetingScreen.tsx:52-85`, `apps/mobile/MOBILE_ENV_CONTRACT.md:13-18`.

## 3) Shipped features and planned or uncleared features

### Features present in the mobile app code

- Create a new meeting and optionally give it a name. `canCreateMeeting()` currently returns `true`, and the home screen routes a new meeting to a host lobby. Source: `apps/mobile/src/lib/chalk.ts:40-51`, `apps/mobile/src/screens/HomeScreen.shared.tsx:97-115`.
- Join from an invite link pasted into the app, from supported HTTPS/deep links, or from a clipboard invite suggestion. Source: `apps/mobile/src/screens/HomeScreen.shared.tsx:38-95`, `apps/mobile/src/lib/chalk.ts:54-78`, `apps/mobile/android/app/src/main/AndroidManifest.xml:37-55`.
- Pre-join lobby with display name plus microphone and camera choices, followed by a joining/loading state, live meeting state, retry, leave, and host “End for All” handling. Source: `sdks/typescript/react-native/src/components/NativeVideoConference.tsx:90-163`, `sdks/typescript/react-native/src/components/NativeVideoConference.tsx:207-300`.
- Live camera and microphone media over the Cloudflare React Native WebRTC adapter, with audio/video toggles and Android/iOS permission declarations. Source: `apps/mobile/src/meeting/MobileMeetingScreen.tsx:75-85`, `sdks/typescript/react-native/src/session/create-chalk-native-session.ts:42-80`, `apps/mobile/app.config.ts:70-88`.
- Participant view, participant count, participant tiles, invite sharing, and host/participant controls such as admission, mute, media requests, role changes, host transfer, removal, and stopping another participant’s camera or screen share when the session capabilities allow them. Source: `apps/mobile/src/meeting/mobile-meeting-features.ts:3-10`, `sdks/typescript/react-native/src/components/native-meeting-room/NativeMeetingOverlays.tsx:141-215`, `sdks/typescript/react-native/src/components/native-meeting-room/useNativeMeetingRoomController.ts:82-112`.
- In-meeting chat with earlier-message loading, read markers, retry for failed sends, and file attachment selection/upload/download hooks. Source: `sdks/typescript/react-native/src/components/native-meeting-room/NativeMeetingOverlays.tsx:56-138`, `apps/mobile/src/lib/chat-attachments.ts:9-39`.
- Reactions and hand raising. Source: `apps/mobile/src/meeting/mobile-meeting-features.ts:7-8`, `sdks/typescript/react-native/src/components/native-meeting-room/NativeMeetingOverlays.tsx:17-43`, `sdks/typescript/react-native/src/components/native-meeting-room/NativeMeetingStage.android.tsx:122-155`.
- Screen sharing is enabled in the mobile feature map, and Android media-projection permissions plus an iOS ReplayKit screen-share extension are present. Source: `apps/mobile/src/meeting/mobile-meeting-features.ts:6`, `apps/mobile/android/app/src/main/AndroidManifest.xml:6-9`, `apps/mobile/ios/ChalkScreenShare/SampleHandler.swift:1-30`.
- Session credentials are persisted in Expo SecureStore so a resumed invite session can be reused, then removed during cleanup. Source: `apps/mobile/src/lib/chalk.ts:81-115`, `CHANGELOG.md:225-233`.

### Features that must be treated as planned, incomplete, or not store-cleared

- **Whiteboard:** the app enables a whiteboard feature flag, and the SDK contains an embedded WebView surface, but the canonical inventory marks “Native mobile whiteboard rendering” false. The mobile whiteboard document calls itself a proposal and says the native stage still renders a placeholder. The changelog also says first-party live exposure remains gated. Do not present whiteboarding as a reliably shipped mobile feature without a current real-device proof and an updated status decision. Sources: `apps/mobile/src/meeting/mobile-meeting-features.ts:3-10`, `sdks/typescript/react-native/src/components/native-meeting-room/NativeMeetingWhiteboardSurface.tsx:1-55`, `product.yaml:135-149`, `docs/chalk-mobile-whiteboard/README.md:1-5`, `CHANGELOG.md:26-32`.
- **Mobile meeting creation:** source enables it today, but `product.yaml` explicitly records “Mobile meeting creation is enabled consistently in release builds” as false. Treat creation as repository-present, release consistency unproven. Source: `product.yaml:52-57`, `apps/mobile/src/lib/chalk.ts:40-51`.
- **Recording and meeting transcription/captions:** the repo has broader API/SDK foundations, but the first-party mobile inventory marks mobile recording and meeting transcripts as not wired, and the app feature map has no recording or transcription controls. Source: `product.yaml:151-192`, `apps/mobile/src/meeting/mobile-meeting-features.ts:3-10`.
- **Offline meetings:** no offline meeting or offline media mode is implemented. The local whiteboard renderer is a separate development/embedding concern, and the React Native whiteboard README says it does not permit new offline authoring. Source: `sdks/typescript/react-native/README.md:3-22`, `apps/mobile/src/lib/chalk.ts:81-115`.

## 4) Likely differentiators versus competitors

The repo contains no competitor comparison, so these are evidence-backed positioning candidates to validate against Zoom, Google Meet, Microsoft Teams, Jitsi Meet, and Whereby rather than established market claims:

- **Invite-link-first access:** the mobile funnel is built around creating a meeting or opening a Chalk invite link, with no visible account sign-in flow. Source: `apps/mobile/src/screens/HomeScreen.shared.tsx:65-115`, `apps/mobile/src/lib/chalk.ts:40-78`.
- **Collaboration inside the call:** the mobile meeting surface combines media, participants, chat, attachments, reactions, hand raising, moderation, and screen sharing in one native meeting room. Source: `apps/mobile/src/meeting/mobile-meeting-features.ts:3-10`, `sdks/typescript/react-native/src/components/native-meeting-room/NativeMeetingOverlays.tsx:17-215`.
- **Open-source foundation:** the root repo describes Chalk as open source and lists an MIT license, while the implementation is built around reusable TypeScript/React Native SDK packages. Source: `README.md:1-5`, `README.md:22-24`.
- **Provider-specific technical story:** the mobile client uses Cloudflare’s React Native WebRTC package and Chalk’s own broker/session/Sync boundaries. This is a technical differentiator, not a user-facing promise of better call quality. Source: `apps/mobile/package.json:29-35`, `apps/mobile/src/meeting/MobileMeetingScreen.tsx:52-85`.

## 5) Monetization

**None found in the mobile app.** No ads SDK, billing SDK, IAP/subscription package, paywall, price, or purchase flow appears in `apps/mobile/package.json`, `apps/mobile/src`, `apps/mobile/app.config.ts`, or the mobile release configuration. The app package is private and the repo contains no mobile pricing or plan copy. This supports “no monetization mechanism found in the repo,” not a claim that the service is free forever. Sources: `apps/mobile/package.json:1-56`, `apps/mobile/src`, `apps/mobile/app.config.ts:21-95`.

## 6) Privacy posture

- **Account:** no account creation, login, or profile-management UI was found. The observed flow uses a broker URL, invite token, display name, and short-lived client-session credentials. Source: `apps/mobile/src/lib/chalk.ts:31-78`, `apps/mobile/src/meeting/MobileMeetingScreen.tsx:52-85`.
- **Tracking/analytics:** journey telemetry is enabled in the meeting screen and persisted in a bounded AsyncStorage queue. The mobile telemetry constructor does not supply an exporter or base URL, and the telemetry client only creates an exporter when one is supplied or a base URL exists. Repository evidence therefore indicates local telemetry instrumentation without a configured remote exporter in this app. Do not turn that into the absolute claim “no analytics” without checking the release build and backend configuration. Sources: `apps/mobile/src/meeting/MobileMeetingScreen.tsx:22-25`, `apps/mobile/src/lib/telemetry.ts:8-13`, `sdks/typescript/client/src/telemetry/client.ts:39-69,143-146`.
- **Apple privacy manifest:** the checked-in manifest declares an empty collected-data list and `NSPrivacyTracking=false`. That is a declared app-manifest posture, not a complete independent audit of network/session data. Source: `apps/mobile/ios/Chalk/PrivacyInfo.xcprivacy:43-46`.
- **Offline and on-device processing:** meetings require network access to the broker/API/Sync/media services. The device stores session credentials in SecureStore, queues telemetry in AsyncStorage, reads selected attachment bytes locally, and computes SHA-256 digests before upload. No on-device transcription or other local AI processing was found. Sources: `apps/mobile/MOBILE_ENV_CONTRACT.md:3-18`, `apps/mobile/src/lib/chalk.ts:81-115`, `apps/mobile/src/lib/telemetry.ts:8-13`, `apps/mobile/src/lib/chat-attachments.ts:20-44`.
- **Permissions/capabilities:** camera, microphone/record audio, Bluetooth, network, audio settings, foreground services, media projection, notifications, vibration, wake lock, and iOS background audio/VoIP are declared. iOS also declares camera, microphone, Face ID, local-network development, photo-library, and ReplayKit-related entries. Some are platform/build requirements rather than proof that every permission is requested in every flow. Sources: `apps/mobile/app.config.ts:50-88`, `apps/mobile/android/app/src/main/AndroidManifest.xml:1-19`, `apps/mobile/ios/Chalk/Info.plist:49-78`.

## 7) Existing listing text and store assets

No Google Play or Apple App Store title/subtitle/long description/keyword field, screenshot set, feature graphic, or store-metadata directory was found. Google Play upload configuration exists, but it contains the package target and credential references rather than listing copy. Source: `apps/mobile/.gplay/config.yaml:1-6`, `apps/mobile/.gplay/config.json:1-13`.

Existing app-facing text that can be quoted as evidence, not reused automatically as store copy:

> “Video meetings for everyone”

> “Connect, collaborate, and celebrate from anywhere with Chalk.”

> “New Meeting”

> “Paste invite link to join...”

> “Name your meeting” and “Meeting Name (Optional)”

> “Start Meeting”

> “Learn more at chalkmeet.com” and “Privacy Policy”

Sources: `apps/mobile/src/screens/HomeScreen.shared.tsx:150-205`.

Meeting UI labels include “Invite participants,” “Participants,” “Chat,” “Present screen,” “Raise hand,” “Open whiteboard,” “Reactions,” and “Leave meeting.” Source: `sdks/typescript/react-native/src/components/native-meeting-room/NativeMeetingOverlays.tsx:9-51`.

Assets found: `apps/mobile/assets/icon.png`, `apps/mobile/assets/splash-logo.png`, Android launcher/adaptive-icon resources under `apps/mobile/android/app/src/main/res`, and the iOS app icon under `apps/mobile/ios/Chalk/Images.xcassets/AppIcon.appiconset`. These are app assets, not a complete store screenshot or promotional-asset set. Source: `apps/mobile/app.config.ts:26-32`, `apps/mobile/ios/Chalk/Images.xcassets/AppIcon.appiconset`, `apps/mobile/android/app/src/main/res`.

## 8) Likely category and search keywords

- **Likely category:** Communication, with Video Conferencing as the narrower product type. Final category selection should follow the target store’s current taxonomy.
- **Keywords:** video meetings; video conference; video call; online meetings; group video call; virtual meeting; remote meeting; team meeting; meeting chat; screen sharing; invite link meeting; mobile video conference; participant reactions; hand raise; meeting whiteboard.

These keywords describe code-visible concepts. “Whiteboard” should be removed or softened until the mobile whiteboard status is resolved.

## 9) Claims to avoid

- “Works offline” or “meetings without internet.” The meeting requires remote broker, API, Sync, and media services.
- “No account is ever required.” The app has no login flow, but that does not prove every deployment or service policy is account-free.
- “Native mobile whiteboard,” “full whiteboard,” or “offline whiteboard authoring.” The canonical repo status and mobile whiteboard document contradict a fully shipped claim.
- “Record meetings,” “transcribe meetings,” “live captions,” “AI summaries,” “calendar scheduling,” or “contacts integration.” These are not wired into the first-party mobile flow.
- “End-to-end encrypted,” “zero data collection,” or “no analytics.” The repo declares no tracked collected data in the Apple manifest and configures local telemetry, but those declarations do not establish the broader security or network-data claims.
- “Unlimited participants,” “HD/4K video,” “crystal-clear audio,” a specific latency guarantee, or universal network reliability. No mobile store-ready proof or supported limit for these claims was found.
- “Free forever,” “no subscriptions,” or “no ads” as a permanent commercial promise. The repo has no mobile monetization mechanism, but it does not define the service’s future pricing policy.
- “Available on macOS or tvOS,” or “currently live on both stores.” The repo shows Android/iOS release surfaces and Google Play upload configuration, not verified live-store publication for every platform.
