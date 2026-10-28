# Sound design

Chalk already has call sounds: the React SDK synthesizes cues and the React
Native SDK plays audio assets. See the [web cues](../../sdks/typescript/react/src/internal/sound-cues.ts)
and [native sounds](../../sdks/typescript/react-native/src/sounds/sounds.ts)
for the current implementation. Selectable sound packs are a planned feature;
the ideas below are design exploration, not a description of what ships today.

## Principles

- Give each pack its own voice while keeping event gestures recognizable across packs: joins rise, departures fall, and errors settle low.
- Frequent sounds should be quieter and shorter than rare ones. Avoid sounds that become irritating with repetition or mask speech.
- Use calm, resolved sounds rather than alarms or prolonged dissonance. Sound must never be the only indication of an event.
- Make cues distinguishable at low volume and in mono. Test on laptop speakers and inexpensive earbuds, including over conversation.
- Coalesce bursts of repeated events and consider quieter feedback for a person's own actions.

## Event grammar

These are candidate gestures for future packs, not a list of implemented events.

- **Frequent:** subtle clicks, messages, reactions, mute, and unmute. Mute falls; unmute rises.
- **Occasional:** a rising join, falling leave, questioning hand raise, a polite nudge or knock, screen-share start and stop, and countdown.
- **Rare:** a low, settled error; recording start and stop; admission and promotion; connection loss and recovery; applause; spinoff open and return; and Episode end.

## Possible voices

The original exploration proposed ten interchangeable voices:

| Voice     | Character                                         |
| --------- | ------------------------------------------------- |
| Chalk     | Felt piano and wooden percussion, warm and close. |
| Porcelain | Airy glass and porcelain bells.                   |
| Paper     | Very quiet, dry paper and brush textures.         |
| Cassette  | Warm, tape-saturated analog synthesizer.          |
| Kalimba   | Intimate kalimba and music box.                   |
| Aurora    | Soft ambient pads.                                |
| Pebble    | Playful, rounded water-drop tones.                |
| Signal    | Short, dry sine-wave blips.                       |
| Hearth    | Breath and warm wooden flute.                     |
| Orbit     | Rounded electric piano with a bell-like edge.     |

For selection, explore per-user and per-device preferences, a tenant default,
and a consistent preview sequence so people can compare packs. These are ideas,
not committed behavior. Audition frequent cues repeatedly, check speech masking,
and compare cues blind before choosing a pack.
