# Chalk iOS App Store Connect Draft

Last updated: 2026-03-31

This draft is grounded in the current Chalk repo and current Apple App Store Connect help pages.

## Current repo-backed app facts

- App name: `Chalk`
- iOS bundle ID: `ai.q9labs.chalk.mobile`
- Current iOS version/build: `0.0.16 (16)`
- Public site: `https://chalkmeet.com/`
- Privacy policy URL: `https://chalkmeet.com/privacy/`
- Support contact page candidate: `https://chalkmeet.com/terms/`
- In-app privacy link: `apps/mobile/src/screens/HomeScreen.tsx`
- iOS permission copy:
  - Camera: `Chalk uses your camera so participants can see you during meetings.`
  - Microphone: `Chalk uses your microphone so participants can hear you during meetings.`
- V1 review notes from repo:
  - no account sign-in required
  - clipboard invite suggestion may trigger the iOS paste prompt
  - iOS full-device screen share is not part of V1

## Apple-required fields to fill

These are the practical fields still needed for first submission:

- Screenshots
- Promotional Text
- Description
- Keywords
- Support URL
- Marketing URL
- Copyright
- App Review contact + notes
- App Privacy questionnaire
- Age Rating questionnaire
- Pricing and Availability
- App Information items if still blank:
  - Subtitle
  - Category
  - Content Rights
  - Privacy Policy URL

Apple references used:

- Platform version information: https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information
- Required properties: https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties
- App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/

## Ready-to-paste metadata

### Name

`Chalk`

### Subtitle

`Low-latency video meetings`

Why this choice:

- accurate to the repo and product
- under Apple's 30-character subtitle limit

### Promotional Text

`Create or join a Chalk meeting in seconds with fast mobile video, chat, transcripts, and whiteboards.`

### Description

`Chalk brings fast, reliable video meetings to mobile.

Create a meeting in seconds or open a Chalk invite link to join right away. Chalk is built for live collaboration, with low-latency audio and video, in-meeting chat, transcripts, and whiteboards designed to keep conversations moving.

Use Chalk to:

- start a new meeting from your phone
- open or paste a Chalk invite link to join quickly
- connect with live audio and video
- follow chat and transcript updates during meetings
- collaborate with whiteboards
- continue meeting flows with deep links

Chalk for iPhone focuses on the core meeting experience: create, join, talk, chat, and collaborate from anywhere.

No account sign-in is required for the current mobile experience.`

### Keywords

`meetings,video,conference,chat,whiteboard,transcript,collaboration,remote,team`

### Support URL

Recommended:

`https://chalkmeet.com/terms/`

Why:

- Apple currently says the Support URL must lead to actual contact info
- this route includes `support@chalk.com` in the repo and returns `200/308 -> 200`

Alternative:

`https://chalkmeet.com/privacy/`

### Marketing URL

`https://chalkmeet.com/`

### Privacy Policy URL

`https://chalkmeet.com/privacy/`

### Copyright

`2026 Q9 Labs`

### Primary Category

Recommended:

- Primary: `Business`
- Secondary: `Productivity`

### Content Rights

Recommended answer:

- `Yes, it contains, shows, or accesses third-party content, and we have the necessary rights`

Reasoning:

- Chalk presents user-generated meeting content from participants

## App Review Information

### Sign-in required

`No`

### Review notes

`Test flow:
1. Open Chalk.
2. Tap "New meeting" to create a room, or paste a valid Chalk invite link.
3. Allow camera and microphone when prompted.
4. Optionally allow the iOS clipboard paste prompt if it appears.

Notes for review:
- No account sign-in is required to use the mobile app.
- Chalk uses camera and microphone for live meetings.
- Chalk uses network access to create and join meetings.
- Chalk stores limited meeting context and host tokens on device so sessions can resume or reconnect.
- Clipboard invite suggestion is a one-tap helper only; it does not auto-join.
- iOS full-device screen share is not part of V1.`

### Review contact

Use a real monitored contact for App Review:

- Name: human owner/operator for this app record
- Email: preferably a monitored mailbox such as `support@chalk.com`
- Phone: monitored phone number that can answer Apple review questions quickly

## Screenshot plan

Your current App Store Connect page is asking for iPhone screenshots first. The visible placeholder on your page accepts:

- `1242 x 2688`
- `2688 x 1242`
- `1284 x 2778`
- `2778 x 1284`

Recommended first 5 screenshots:

1. Home screen with Chalk branding, `New meeting`, and invite field.
2. Home screen with clipboard invite suggestion visible.
3. Invite-link join flow.
4. Live meeting view with participant video.
5. Collaboration surface such as chat, transcript, or whiteboard.

Capture rules:

- use a production-like build, not a dev shell
- avoid diagnostics overlays
- do not show any unfinished or unsupported feature
- keep screenshots truthful to the actual iPhone experience

## App Privacy draft

This still needs a final owner/legal pass, but repo evidence suggests the iOS questionnaire will likely include:

- Data collected:
  - Audio
  - Video
  - Messages
  - User content such as whiteboard and transcript content
  - Diagnostic or device data needed for app functionality
- Sensitive permissions:
  - Camera
  - Microphone
- Clipboard behavior:
  - app may inspect clipboard to suggest a Chalk invite already on device
- No evidence found in `apps/mobile` of:
  - ads SDKs
  - mobile analytics SDK
  - location collection
  - contacts access

## Likely submission blockers

- Screenshots are still missing
- App Privacy questionnaire still needs to be completed carefully
- Age Rating questionnaire still needs to be answered
- Review contact phone/name still needs final owner input
- Helium browser automation is blocked because remote debugging is not enabled on the running Helium instance

## Helium attach note

If you want browser automation on the live App Store Connect page, Helium needs to be launched with remote debugging enabled, for example on port `9222`. Right now the app is running, but nothing is listening on `localhost:9222`, so agent-browser cannot attach yet.
