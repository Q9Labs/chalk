# Chalk Mobile Store Review Helper

Last updated: 2026-03-22

## Privacy policy URL options

- Primary: `https://chalkmeet.com/privacy/`
- Backup: `https://chalkmeet.com/privacy-policy/`
- If a store field rejects the trailing slash, use the same path after the web deploy is confirmed to preserve the 200 response.

## App Store reviewer notes

Test flow:

1. Open Chalk.
2. Tap `New meeting` to create a room, or paste a valid invite link.
3. Allow camera and microphone when prompted.
4. Optionally allow the iOS clipboard paste prompt if it appears.

Notes for review:

- No account sign-in is required to use the mobile app.
- Chalk uses camera and microphone for live meetings.
- Chalk uses network access to join and create meetings.
- Chalk stores meeting context and host tokens on device so sessions can resume or reconnect.
- Clipboard invite suggestion is a one-tap helper only; it does not auto-join.
- Android mobile-originated screen share is disabled in V1.
- iOS full-device screen share is not part of V1.

## Google Play reviewer notes

Test flow:

1. Open Chalk.
2. Tap `New meeting` to create a room, or paste a valid invite link.
3. Allow camera and microphone when prompted.
4. Verify the clipboard invite card appears only when a Chalk invite is already on the clipboard.

Notes for review:

- No account sign-in is required to use the mobile app.
- Chalk uses camera and microphone for live meetings.
- Chalk uses network access to join and create meetings.
- Clipboard invite suggestion reads the clipboard only to detect Chalk invite links.
- Android mobile-originated screen share is disabled in V1.

## Data safety draft

Collects:

- Name / display name
- Audio
- Video
- Chat messages
- Transcript content
- Whiteboard content
- Meeting metadata and participant state
- Device or diagnostic information needed to operate the app

Shared with others:

- Meeting content is shared with meeting participants as part of the product.
- Service providers used to operate the app may process the same meeting data.

Not currently surfaced as mobile analytics:

- No mobile PostHog / analytics SDK wiring found in `apps/mobile`

Device-only storage:

- Host API token cache
- Join context cache
- These are stored locally in `expo-secure-store`

## App content draft

- Age rating: likely `Everyone` or store-equivalent video meeting rating, pending final store questionnaire
- Sensitive content: live user-generated audio/video/chat/transcript/whiteboard content
- User interaction: yes, direct communication between meeting participants
- Users can join by invite link without a separate account flow in the mobile app

## Manual inputs still needed

- Final store-accepted privacy URL
- Final App Store review contact email / phone / demo notes if requested
- Final Play Data Safety selections for shared vs collected fields
- Final age/content rating answers in each console
- Any reviewer-only test invite link if you want a guaranteed join path
