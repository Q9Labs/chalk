# Chalk mobile store listing

Copy for the Android and iOS listings. Check each claim against
[tracker.yaml](../tracker.yaml) and the final native build before submission.
The words match the app: a person starts a call and joins with a link.

## Pre-submission checklist

- Verify the published privacy-policy URL in the submission environment.
- Inspect the final archive's permissions and remove declarations the app does
  not need.
- Prepare store screenshots and functional reviewer access with an invite link.
- Verify native media on physical devices before publishing.

## Title

Chalk Calls

## Google Play short description

Start or join a low-latency video call from a link. Chat, react, share files.

## Google Play full description

Chalk is a simple way to start or join a video call from your phone.

Tap Start a call and share the link, or open a Chalk link to join right away. No account is needed.

In a call you can:

- talk with clear, low-latency audio and video
- switch between Spotlight and Grid, and pin the person you want to see
- see who is talking from the ring around their tile
- raise your hand or send a quick reaction
- chat with everyone and share files
- see the People list and who is muted
- watch a screen or whiteboard someone else shares
- pick your audio output and turn your phone sideways for a bigger view

Each person without a camera gets a friendly animated face, so a call never feels like a wall of initials. Chalk comes in Dark and Light, and you choose which one you want.

Chalk is open source (MIT), and one engine runs web, iOS and Android.

## Apple App Store subtitle

Low-latency video calls

## Apple App Store keywords

meeting,meet,team,remote,work,conference,huddle,group,online,chat,collaboration,live,link,invite

## Apple App Store promotional text

Start a call in one tap and share the link. Anyone can join from a phone, with no account needed.

## Apple App Store description

Chalk is a simple way to start or join a video call from your phone.

Tap Start a call and share the link, or open a Chalk link to join right away. No account is needed.

In a call you can:

- talk with clear, low-latency audio and video
- switch between Spotlight and Grid, and pin the person you want to see
- see who is talking from the ring around their tile
- raise your hand or send a quick reaction
- chat with everyone and share files
- see the People list and who is muted
- watch a screen or whiteboard someone else shares
- pick your audio output and turn your phone sideways for a bigger view

Each person without a camera gets a friendly animated face, so a call never feels like a wall of initials. Chalk comes in Dark and Light, and you choose which one you want.

Chalk is open source (MIT), and one engine runs web, iOS and Android.

## Icons and screenshots

Both stores use the white chalk stick on a dark plate. The Play icon is
`apps/web/public/brand/chalk/chalk-icon.svg` drawn at 512 px with square
corners, because Play rounds them. Screenshots come from the current app with the demo call (Hasan,
Nora Patel, Akash Rao, Sofia Lind, Malik Haddad, Priya Shah): Home, Grid,
Spotlight, More, Chat and People.

## Google testing instructions

Provide a test call invite URL. Reviewers can open the link or paste it in
the app, grant camera and microphone, and join. The app shows a screen or
whiteboard that another person shares. It does not start a share itself.

## Apple review notes

Provide a test call invite URL and a second device as another participant.
Reviewers can open the link to join. Camera and microphone are used while in a
call. The app shows a screen or whiteboard that another person shares and does
not start a share itself. It declares the audio and VoIP background modes for
live media.
