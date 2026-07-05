# Chalk — Sound Design (ElevenLabs edition)

_Companion to [north-star.md](./north-star.md). Sound is part of value #2 — **Fast**: every state signal feels instant, and a well-placed 90ms tone lands before any pixel does. This doc defines the event vocabulary, the shared musical grammar, ten sound sets — and every sound as a copy-paste-ready ElevenLabs prompt._

---

## Philosophy

**A sound set is a voice; the grammar is the language.** Every set pronounces the *same* musical gestures — join always rises, leave always falls, error always settles low — but in its own timbre, key, and space. The family resemblance is structural (intervals, rhythm, envelope logic), not just a shared reverb preset. A user can switch sets and lose nothing — they already speak the language.

**The enemy is annoyance, and annoyance is a function of repetition.** A sound heard once per meeting can afford character. A sound heard forty times must approach transparency. Loudness, length, and personality are budgeted by *frequency of occurrence*, not importance.

**Pleasant means resolved.** No buzzers, no alarms, no dissonance held as tension. Even the error sound ends on a stable tone — it says "that didn't work," never "you did something wrong."

---

## Prompting ElevenLabs

Model: `eleven_text_to_sound_v2` (Text to Sound Effects). Each generation is independent — the model has no memory of the set — so **consistency is carried entirely by the prompt text**. Every prompt is assembled from three verbatim-reused parts:

```
<VOICE BLOCK — the set, identical in every prompt> UI notification sound: <GESTURE — the event, identical across sets>. <SUFFIX>
```

**Suffix (global, every prompt):** `One-shot, gentle and pleasant, high-quality professionally designed app notification sound, clean and minimal.`

**Parameters**

- `prompt_influence`: **0.7** — UI families need literal, repeatable takes, well above the 0.3 default. Drop to ~0.45 only if takes come back stiff or identical.
- `duration_seconds`: set explicitly per event (table below). API minimum is 0.5s; sounds with a sub-150ms budget are generated at 0.5–1s and tightened in post.
- `loop`: **false** for everything — these are all one-shots.
- Output: request the highest PCM/MP3 tier available; master at 48 kHz.

**Prompt writing rules** (from the official guide, applied)

- Concrete sound-design vocabulary beats poetry: name the instrument, the register, the space ("soft felt piano", "dry, no reverb", "small warm room").
- Musical descriptors work — keys, intervals, chords ("in F major", "rising a perfect fifth", "add9 chord") — but pair every interval with plain-audio language ("two ascending notes, low to high") as insurance.
- Sequence multi-part sounds with **"then"**: "three rising notes, then a soft held confirmation tone."
- State positives, never negations: "gentle, calm, soft" — not "not harsh, not annoying."
- Keep prompts ~15–35 words; detail sharpens, bloat dilutes.

**Workflow per sound:** generate 4–6 takes → audition against the set's existing keepers (does it sound like the same instrument in the same room?) → pick one → post-process (below) → QA gauntlet.

---

## Global rules (every set obeys these)

1. **Duration budget** (final trimmed asset, not generation length): tier-1 ≤ 150ms of gesture + natural tail, tier-2 ≤ 400ms, tier-3 ≤ 800ms. One exception: *call-end* may run ~1.2s — the only lyrical moment a set gets.
2. **Loudness by tier, not by set.** All sets normalized to equal perceived loudness; within a set, tier-1 sits ~6 dB under tier-3. Peaks ≤ −6 dBFS; the loudest event sits comfortably under conversational speech.
3. **Spectral home 500 Hz – 4 kHz.** High-pass ~200 Hz in post (laptop speakers; speech masking), gentle above 8 kHz (fatigue). Every sound must survive a MacBook speaker and a $20 earbud.
4. **Speech-aware ducking.** While remote speech is active, sounds duck −12 dB or defer ≤ 500ms for a gap.
5. **Coalescing.** ≥3 joins in 5s → one join sound. Messages: max one sound per 3s per room. ≥5 reactions in 2s → single *applause* swell instead of five pops.
6. **Self vs. remote.** Your own actions play −4 dB quieter and drier — you already have visual confirmation.
7. **Sound is never the only signal** (a11y, muted tabs) — and each event must be identifiable blind: distinct in mono, at low volume.
8. **Delivery:** 48 kHz/24-bit WAV masters, OGG + AAC delivery, < 50 KB per file. Naming: `sounds/<set>/<event>.<ext>` — the vocabulary is the contract; sets are interchangeable implementations.

---

## Event vocabulary — gesture phrases

The **gesture phrase** below is inserted verbatim into every set's prompt. `dur` = `duration_seconds` to request; trim to the tier budget in post.

### Tier 1 — many times per meeting (near-transparent)

| Event | dur | Gesture phrase |
|---|---|---|
| `click` | 0.5 | `a single tiny damped woody tap, an extremely subtle and quiet interface click` |
| `message` | 0.5 | `one single soft short mid-register note, calm, neutral and fully resolved` |
| `reaction` | 0.5 | `a quick tiny grace-note flick up to one high sparkling note, light and playful` |
| `mute-self` | 0.5 | `two quiet low notes stepping down a whole step, soft and damped, like a door gently closing` |
| `unmute-self` | 0.5 | `two quiet low notes stepping up a whole step, soft and damped, like a door gently opening` |

### Tier 2 — a few times per meeting (quietly characterful)

| Event | dur | Gesture phrase |
|---|---|---|
| `join` | 1.0 | `two soft ascending notes rising a perfect fifth, low to high, open and welcoming` |
| `leave` | 1.0 | `two soft descending notes falling a perfect fifth, high to low, a gentle quiet farewell` |
| `hand-raise` | 1.0 | `two notes rising a perfect fourth and ending unresolved, curious, like a polite question` |
| `nudge` | 0.8 | `two quick soft repeated taps on the same note, a polite friendly knock for attention` |
| `knock` | 0.8 | `two soft muffled knocking taps in the low-mid register, polite and unhurried` |
| `screen-share-start` | 1.0 | `two notes leaping up a full octave, low to high, airy, like a window opening` |
| `screen-share-stop` | 1.0 | `two notes falling a full octave, high to low, settling, like a window closing` |
| `countdown` | 0.8 | `a gentle calm double-note pulse, a soft unhurried time reminder` |

### Tier 3 — once per meeting or rarer (full character allowed)

| Event | dur | Gesture phrase |
|---|---|---|
| `error` | 1.0 | `two soft notes falling a minor third and settling on a stable low tone, apologetic, calm and kind, never harsh` |
| `recording-start` | 1.5 | `three deliberate ascending notes, then a short soft held confirmation tone, formal and clear` |
| `recording-stop` | 1.5 | `three deliberate descending notes coming to a complete rest, formal and reassuring` |
| `admitted` | 1.2 | `a warm ascending three-note arpeggio, resolved and glowing, the sound of being welcomed in` |
| `promoted` | 1.0 | `a bright rising arpeggio outlining a major chord, quietly celebratory, being handed something` |
| `connection-lost` | 1.0 | `a single quiet low tone bending slightly downward in pitch, subdued and soft, like a light dimming` |
| `connection-restored` | 1.0 | `a single quiet low tone bending upward back to pitch, warm and relieved, like a light returning` |
| `applause` | 1.5 | `a soft shimmering swell of many tiny overlapping high notes, gentle sparkling celebration` |
| `breakout-open` | 1.2 | `two soft chords moving upward and outward, doors opening onto smaller rooms` |
| `breakout-return` | 1.2 | `two soft chords resolving back home, warm and settling` |
| `call-end` | 2.0 | `a gentle descending four-note cadence coming to complete rest, a soft unhurried goodbye` |

---

## The ten sets — voice blocks

Each voice block is used **verbatim** at the start of all 24 prompts for that set. Signature details are per-event prompt substitutions.

### 1. Chalk _(default)_
> `Soft felt piano and warm wooden mallet percussion, matte and intimate, in F major pentatonic, recorded close in a small warm room.`

The house voice — warm, a little schoolroom-poetic, like the product name. **Signature detail:** on `click` and `join`, append `with a faint dusty chalk-tap texture at the attack`.

### 2. Porcelain
> `Delicate glass and porcelain bells, pure airy sine tones, in A major, with faint slow shimmering tails, weightless and premium.`

Jewelry. **Signature detail:** append `two bell tones subtly detuned so the tail breathes slowly` on tier-3 events only — tier-1 stays plain so tails never stack.

### 3. Paper
> `Soft paper and brush foley, breathy filtered air, almost pitchless, extremely quiet, delicate and dry.`

For sound-sensitive people and open offices; rendered ~4 dB under global normal. Pitch words in gestures read as filter sweeps here — that's intended. **Signature detail:** `join` / `leave` become `a single soft page turning forward` / `a single soft page turning backward`.

### 4. Cassette
> `Warm vintage analog synthesizer through gentle tape saturation, mellow triangle-wave tones with slight wow and flutter, in D dorian, nostalgic lo-fi warmth.`

**Signature detail:** `recording-start` / `recording-stop` prepend `a soft mechanical tape-deck button ka-chunk, then` — the set's thesis.

### 5. Kalimba
> `Intimate kalimba and music box, close-miked plucked metal tines, slightly detuned pairs, in G major, tiny and warm.`

**Signature detail:** `call-end` becomes `a four-note music box phrase winding gently down to rest, like a lid softly closing`.

### 6. Aurora
> `Airy ambient synthesizer pads, breath-soft tones with slow blooming attacks, in C lydian, spacious dark reverb, calm and floating.`

The evening set — every attack a bloom, never a strike; trim blooms hard in post to hold tier budgets. **Signature detail:** its `connection-lost` / `connection-restored` pair is the set's best moment — keep the light-dimming language and add `like a pad losing power` / `warming back to full brightness`.

### 7. Pebble
> `Round resonant water-drop plinks on marimba, sine tones with a soft droplet pitch-fall at each onset, in E major pentatonic, playful and clean.`

Fun that never gets silly. **Signature detail:** `reaction` becomes `a single bright water droplet with a tiny splash sparkle`.

### 8. Signal
> `Minimal precise sine-wave blips, tiny clean digital tones, completely dry with no reverb, clinical and calm.`

The minimalist — function over feeling; everything trimmed < 150ms in post regardless of tier. **Signature detail:** none. Restraint is the signature.

### 9. Hearth
> `Soft breathy ocarina and low wooden flute, warm human breath in the tone, in B-flat major, recorded in a small wooden room, folk warmth.`

The set that feels most *played by a person*. **Signature detail:** `hand-raise` appends `a genuinely questioning little blown lift, almost vocal`.

### 10. Orbit
> `Warm Rhodes electric piano with a soft bell tine layered on top, mellow add9 chord colors, in F-sharp major, plush studio reverb, modern and rounded.`

The modern-product voice — Slack/Notion territory but warmer. **Signature detail:** `admitted` appends `completing the chord that the knock began` — getting through the lobby audibly finishes the thought.

---

## Example — assembled prompts (Chalk set)

```
Soft felt piano and warm wooden mallet percussion, matte and intimate, in F major pentatonic, recorded close in a small warm room. UI notification sound: two soft ascending notes rising a perfect fifth, low to high, open and welcoming, with a faint dusty chalk-tap texture at the attack. One-shot, gentle and pleasant, high-quality professionally designed app notification sound, clean and minimal.
```
→ `join`, `duration_seconds: 1.0`, `prompt_influence: 0.7`

```
Soft felt piano and warm wooden mallet percussion, matte and intimate, in F major pentatonic, recorded close in a small warm room. UI notification sound: two soft notes falling a minor third and settling on a stable low tone, apologetic, calm and kind, never harsh. One-shot, gentle and pleasant, high-quality professionally designed app notification sound, clean and minimal.
```
→ `error`, `duration_seconds: 1.0`, `prompt_influence: 0.7`

Every other prompt assembles the same way: voice block + gesture phrase (+ signature substitution where noted) + suffix.

---

## Post-processing (every keeper take)

1. Trim leading silence to zero; tighten the gesture to its tier budget; fade the tail (10–30ms out-fade, longer for tier-3).
2. High-pass at 200 Hz; de-ess/notch anything shrill above 8 kHz.
3. Normalize to the set's tier ladder (tier-1 ~6 dB under tier-3), peaks ≤ −6 dBFS.
4. Optional pitch-correct to the set's key if a take drifted — inter-event intervals matter more than absolute pitch, but overlapping sounds should never clash.
5. Mono-sum check before export.

## QA — the annoyance gauntlet (every set passes all six)

1. **The 30× loop test:** `message` played 30 times in a row. If you flinch by #25, it fails.
2. **The laptop test:** full vocabulary on built-in MacBook speakers at 50% volume — everything audible, nothing shrill.
3. **The speech test:** each tier-1/2 sound played over recorded conversation — if it ever masks a word, it fails.
4. **The blind test:** a listener who's heard the set twice identifies join vs. leave vs. message vs. error without looking.
5. **The mono test:** full set summed to mono — no phase-cancelled ghosts, all events still distinct.
6. **The midnight test:** full set at low volume in a silent room — nothing startles.

## Choosing

**Default:** Chalk. **Quiet / sensory-sensitive:** Paper or Signal. **Late-night:** Aurora. Selection is per-user, per-device; tenant admins pick the tenant default. The preview UI plays a fixed demo reel (join → message → hand-raise → reaction → leave) so sets are compared on identical material.
