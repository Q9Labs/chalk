# Chalk Android Play Store Drafts

Last updated: 2026-03-22

## Repo-backed status

- Package: `ai.q9labs.chalk.mobile`
- Current Android version: `0.0.12 (12)`
- Internal testing track: latest upload target should use `versionCode 12`
- Public privacy policy URL: `https://chalkmeet.com/privacy`
- In-app privacy-policy link: mobile home footer
- Current tracked icon candidate: `apps/mobile/assets/icon.png`
  - size: `512x512`
  - sha256: `853372e3bdd0fecc4988643e0303e3630d42ba635b23d6b0ec14cfff352aef6f`
  - note: current Google Play guidance allows a `512x512` 32-bit PNG app icon with alpha; no repo change needed for this source file on that basis alone

## Store listing draft

### App name

`Chalk`

### Short description

`Low-latency video meetings with chat, transcripts, and whiteboards.`

### Full description

`Chalk brings fast, reliable video meetings to mobile.

Create a meeting in seconds or open a Chalk invite link to join right away. Chalk is built for live collaboration, with ultra low-latency audio and video, in-meeting chat, transcripts, and whiteboards designed to keep conversations moving.

Use Chalk to:

- start or join meetings from your phone
- share audio and video with low latency
- follow live chat and transcript updates
- collaborate with whiteboards during meetings
- reopen Chalk invite links directly from supported deep links

Chalk Android v1 is focused on the core meeting experience: create, join, talk, chat, and collaborate from anywhere.`

## Graphics and listing assets

### Missing human-supplied assets

- Phone screenshots are still missing in-repo.
- Feature graphic is still missing in-repo.

### Recommended screenshot set

- `01-home.png`
  - Home screen with `New meeting`, paste field, and branding visible.
- `02-clipboard-invite.png`
  - Home screen showing the clipboard invite suggestion card.
- `03-meeting-stage.png`
  - In-room view with live video tiles.
- `04-chat-transcript-whiteboard.png`
  - One capture each of chat, transcript, or whiteboard panel if space permits.

### Capture notes

- Use a clean production-like build, not Expo dev chrome.
- Prefer portrait phone captures first.
- Avoid placeholder/debug overlays and unstable local URLs.
- Screenshots and feature graphics still need non-alpha assets.

## Data safety draft

This section is a repo-derived draft, not a legal sign-off. It should be reviewed by the product owner before submission on any track beyond internal testing.

### Current likely answers from repo audit

- Data collected: `Yes`
- Data shared with third parties: `Needs owner/legal confirmation`
- Data processed ephemerally off-device: `Likely yes` for live meeting media and signaling

### Likely collected data categories

- Audio
  - Why: core meeting functionality
  - Required for app functionality: `Yes`
- Video
  - Why: core meeting functionality
  - Required for app functionality: `Yes`
- Messages
  - Why: in-meeting chat
  - Required for app functionality: `Yes`
- App info and performance
  - Why: troubleshooting and service reliability
  - Required for app functionality: `Likely yes`
- Personal info such as name or email
  - Current repo confidence: `Low`
  - Mobile shell does not currently expose Google sign-in or profile collection in-tree; verify against the exact reviewed build before answering `No`

### Categories with no evidence in current repo

- Location
- Contacts
- SMS or call logs
- Financial info
- Health data
- Photos/files outside meeting media flows
- Advertising ID usage

## App content draft

### App access

- Suggested answer: `All functionality is available without special access`
- Notes:
  - No login, reviewer account, OTP, or paywall is present in the current mobile app shell.
  - Reviewers can launch the app directly to the home screen and inspect the join flow without credentials.

### Ads

- Suggested answer: `No, this app does not contain ads`
- Repo basis: no mobile ads SDK or ad surface found in `apps/mobile`

### Health apps

- Suggested answer: `No, this is not a health app`

### News apps

- Suggested answer: `No, this is not a news app`

### Target audience and content

- Needs human product decision in Play Console.
- Recommended direction: do not position Chalk as a children-directed app unless product/compliance explicitly wants that burden.

### Content rating questionnaire

- Needs human completion in Play Console.
- Expect the result to depend on how user-generated communication features are declared.

## Reviewer notes draft

`Chalk is a low-latency video meeting app. No login or reviewer account is required for the reviewed Android build. Launch the app to reach the home screen, then either tap "New meeting" or paste/open a Chalk invite link. The current Android v1 build focuses on core meetings: join/create, audio, video, chat, transcripts, and whiteboards. Mobile-originated Android screen sharing is intentionally disabled in this version. Camera and microphone permissions are only used for live meeting participation. Privacy policy: https://chalkmeet.com/privacy`

## Remaining human/store inputs

- Capture and upload Play phone screenshots
- Create and upload a feature graphic if desired for richer storefront placement
- Final owner/legal review of Data safety answers
- Final owner confirmation of App content answers
- Complete target audience and content rating questionnaire in Play Console
- Paste reviewer notes into Play Console review flow
