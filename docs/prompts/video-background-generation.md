# Video Background Generation Prompt

Use this prompt pattern when generating Chalk virtual backgrounds. The goal is a
curated set of video-call-safe images: polished, calm, low-distraction, and
usable behind a centered speaker.

## Base Prompt

```text
Use case: photorealistic-natural
Asset type: 16:9 virtual background for video conferencing
Primary request: <specific room, studio, lounge, terrace, or abstract scene>
Scene/backdrop: <clear description of the environment and a few tasteful details>
Subject: no people, no faces, no readable text, no logos
Style/medium: photorealistic interior or architectural photography
Composition/framing: wide landscape frame, webcam-friendly, gentle depth of field, clean middle area for a speaker silhouette, visual detail mostly at the sides
Lighting/mood: soft natural or ambient light, calm, premium, not flashy
Color palette: restrained, balanced, and low-contrast
Constraints: must look believable as a video conferencing background; no clutter, no screens with content, no brand marks, no watermark, no text
```

For a non-room option, switch the use case and style:

```text
Use case: stylized-concept
Style/medium: refined 3D render with realistic soft materials, not cartoonish
```

## Current Six-Background Set

Use these scene prompts as a starting set:

- `modern-acoustic-office`: contemporary workspace with matte acoustic panels,
  natural wood, plants, and soft shelf details.
- `warm-executive-home-office`: refined home office with built-in shelves,
  linen curtains, a table lamp, walnut, and muted navy accents.
- `bright-creative-studio`: airy creative studio with soft plaster, abstract
  material swatches without text, light oak, clay, sage, and pale blue-gray.
- `garden-terrace-lounge`: covered terrace or indoor-outdoor lounge with soft
  curtains and blurred garden greenery.
- `soft-abstract-glass`: abstract layered glass/fabric panels with a quiet
  center zone and restrained blue, gray, coral, lavender, and off-white tones.
- `cozy-evening-lounge`: warm lounge corner with shelves, lamps, ceramics,
  plants, cream, charcoal, walnut, and deep green accents.

## Production Notes

- Generate 16:9 landscape images.
- Normalize selected outputs to `1280x720`.
- Export AVIF as the preferred format and WebP as fallback.
- Use semantic filenames plus a content hash:
  `<scene-name>.<sha256-prefix>.avif` and
  `<scene-name>.<sha256-prefix>.webp`.
- Upload hashed media with one-year immutable caching.
- Keep the package surface metadata-only; do not bundle background binaries in npm packages.
