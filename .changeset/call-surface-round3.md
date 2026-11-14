---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": minor
---

`participants.admissionPolicy` holds the call's "Who can join" value, and `client.participants.setAdmissionPolicy("open" | "knock")` lets a Participant with `manageAdmission` change it during the call. The People panel shows it as a "Who can join" pill beside Mute everyone for hosts.

While Sync recovers, other people's tiles keep their picture and microphone state as long as the SFU still delivers their tracks, instead of dropping to the avatar.

A failed microphone or camera start says which device didn't reach the call, in one line with Try again. A recording start that the call's policy refuses says "Recording is off for this call."
