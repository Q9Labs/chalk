# Chalk mobile store listing draft

First-submission draft for Android and iOS (`ai.q9labs.chalk.mobile`). Copy
centers on joining a Space from an invite link, because `product.yaml` keeps
Space creation out of mobile release builds.

## Pre-submission blockers (fix before publishing)

- No privacy policy exists (the web privacy route renders blank per
  `product.yaml`); both stores require a working privacy policy URL.
- No store screenshots or promo assets exist yet; the redesign mockups are
  design references, not store captures.
- The checked-in iOS Info.plist declares Face ID, photo-library, and
  local-network permission strings that the production Expo config does not
  supply; inspect the final uploaded archive and drop any that are unused.
- No standing test-Space invite URL exists for reviewer access; both stores
  require functional review access, so create one before submission (the
  TODO markers below).
- `product.yaml` flags real-device native media as unproven; verify on
  hardware before going live.

## Title

Chalk: Video Spaces & Chat

## Short description

Live video Spaces from an invite link: chat, reactions, and screen share.

## Google Play full description

The Space goes live in two minutes and you're not at your desk. Tap the
invite link: you're in.

Chalk is made for joining from your phone. No sign-in flow in the app: an
invite link is your ticket.

Join in seconds

- Open an invite link, or let Chalk spot one on your clipboard and offer to
  join.
- The Entrance shows your camera and microphone before anyone sees you.

Everything a live Space needs

- Live video and audio with a full Participant list.
- Chat, emoji reactions, and hand raising.
- Share your phone's screen with everyone.

Run the Space

- Admit or turn away visitors at the Entrance.
- Mute Participants, request a mic or camera, stop a share.
- Remove someone from the Space entirely.

Built in the open

- Chalk's engine is open source (MIT), shared between web and mobile.
- No third-party analytics SDKs in the app.

Next time someone sends a Chalk link, don't scramble for a laptop. Tap it.

## Apple App Store subtitle

Join a Space from a link

## Apple App Store keywords

video,team,remote,work,screen,share,collaboration,classroom,webinar,online,huddle,group,live

## Apple App Store promotional text

Someone sent you a Chalk link? That's all you need. Tap it, check your
camera at the Entrance, and join live: chat, reactions, and screen share
included.

## Apple App Store description

The Space goes live in two minutes and you're not at your desk. Tap the
invite link: you're in.

Chalk is made for joining from your iPhone or iPad. No sign-in flow in the
app: an invite link is your ticket.

Join in seconds:

- Open an invite link, or let Chalk spot one on your clipboard and offer to
  join.
- The Entrance shows your camera and microphone before anyone sees you.

Everything a live Space needs:

- Live video and audio with a full Participant list.
- Chat, emoji reactions, and hand raising.
- Share your screen with ReplayKit.

Run the Space:

- Admit or turn away visitors at the Entrance.
- Mute Participants, request a mic or camera, stop a share.
- Remove someone from the Space entirely.

Built in the open:

- Chalk's engine is open source (MIT), shared between web and mobile.
- No third-party analytics SDKs in the app.

Next time someone sends a Chalk link, don't scramble for a laptop. Tap it.

## Google testing instructions

No account or sign-in flow. Reviewers need an invite link to join a Space.
TODO: supply a standing test-Space URL created from the Chalk web app. Open
the link (or paste it in the app), grant camera and microphone at the
Entrance, and join. Screen share uses Android media projection and prompts
before capturing.

## Apple review notes

No account or sign-in flow; the app joins a Space via invite links. TODO:
supply a standing test-Space URL created from the Chalk web app, plus a
second device as another Participant. Camera and microphone are used only at
the Entrance and while live; screen sharing uses ReplayKit and is
user-initiated; the app declares the audio and VoIP background modes for
live media.

## Claims deliberately avoided (keep it this way)

"Available on Play/App Store" until actually live; Space creation on mobile
(disabled in release builds); whiteboard on mobile (native rendering
unshipped per `product.yaml`); durable chat history or file attachments
(flagged unshipped); recording, captions, or transcription in the mobile
flow; end-to-end encryption (explicitly false); "completely private" or "no
data collected"; offline use; macOS support; pricing claims ("free forever",
"no ads"); Participant counts, HD/4K, latency, or reliability guarantees;
"no account required" as an absolute (say "no sign-in flow in the mobile
app").
