export const CHALK_ASSET_CDN_BASE_URL = "https://assets.chalkmeet.com/ui/" as const;

export const CHALK_ASSET_MANIFEST_URL = "https://assets.chalkmeet.com/ui/manifest.json" as const;

export const CHALK_ASSET_CACHE_POLICY = {
  media: "public, max-age=31536000, immutable",
  manifest: "public, max-age=300, stale-while-revalidate=86400",
} as const;

type ChalkAssetVariant = {
  readonly url: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256Prefix: string;
};

type ChalkBackgroundAsset = {
  readonly description: string;
  readonly width: number;
  readonly height: number;
  readonly avif: ChalkAssetVariant;
  readonly webp: ChalkAssetVariant;
};

type ChalkSoundAsset = {
  readonly opus: ChalkAssetVariant;
  readonly mp3: ChalkAssetVariant;
};

export const CHALK_BACKGROUND_ASSETS = {
  "bright-creative-studio": {
    description: "Airy creative studio with soft plaster, plants, and subtle material swatches.",
    width: 1280,
    height: 720,
    avif: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/bright-creative-studio.7abcfb577656.avif",
      filename: "bright-creative-studio.7abcfb577656.avif",
      mimeType: "image/avif",
      bytes: 32014,
      sha256Prefix: "7abcfb577656",
    },
    webp: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/bright-creative-studio.fb65d5b296a5.webp",
      filename: "bright-creative-studio.fb65d5b296a5.webp",
      mimeType: "image/webp",
      bytes: 55688,
      sha256Prefix: "fb65d5b296a5",
    },
  },
  "cozy-evening-lounge": {
    description: "Warm evening lounge corner with shelves, ceramics, plants, and soft lamps.",
    width: 1280,
    height: 720,
    avif: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/cozy-evening-lounge.3668f9fb3ae6.avif",
      filename: "cozy-evening-lounge.3668f9fb3ae6.avif",
      mimeType: "image/avif",
      bytes: 15912,
      sha256Prefix: "3668f9fb3ae6",
    },
    webp: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/cozy-evening-lounge.dc7786d5fdd2.webp",
      filename: "cozy-evening-lounge.dc7786d5fdd2.webp",
      mimeType: "image/webp",
      bytes: 25624,
      sha256Prefix: "dc7786d5fdd2",
    },
  },
  "garden-terrace-lounge": {
    description: "Calm indoor-outdoor terrace lounge with linen curtains and blurred greenery.",
    width: 1280,
    height: 720,
    avif: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/garden-terrace-lounge.ec01ea565f77.avif",
      filename: "garden-terrace-lounge.ec01ea565f77.avif",
      mimeType: "image/avif",
      bytes: 35462,
      sha256Prefix: "ec01ea565f77",
    },
    webp: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/garden-terrace-lounge.0a6b0d4fdf87.webp",
      filename: "garden-terrace-lounge.0a6b0d4fdf87.webp",
      mimeType: "image/webp",
      bytes: 66532,
      sha256Prefix: "0a6b0d4fdf87",
    },
  },
  "modern-acoustic-office": {
    description: "Modern professional office with acoustic panels, plants, and warm wood accents.",
    width: 1280,
    height: 720,
    avif: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/modern-acoustic-office.38e4bc5acdec.avif",
      filename: "modern-acoustic-office.38e4bc5acdec.avif",
      mimeType: "image/avif",
      bytes: 21467,
      sha256Prefix: "38e4bc5acdec",
    },
    webp: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/modern-acoustic-office.7e2e3e0b1f83.webp",
      filename: "modern-acoustic-office.7e2e3e0b1f83.webp",
      mimeType: "image/webp",
      bytes: 38384,
      sha256Prefix: "7e2e3e0b1f83",
    },
  },
  "soft-abstract-glass": {
    description: "Subtle abstract glass and fabric-like panels with calm layered color.",
    width: 1280,
    height: 720,
    avif: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/soft-abstract-glass.1bd6ec278f69.avif",
      filename: "soft-abstract-glass.1bd6ec278f69.avif",
      mimeType: "image/avif",
      bytes: 7113,
      sha256Prefix: "1bd6ec278f69",
    },
    webp: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/soft-abstract-glass.2fd3949e2036.webp",
      filename: "soft-abstract-glass.2fd3949e2036.webp",
      mimeType: "image/webp",
      bytes: 10752,
      sha256Prefix: "2fd3949e2036",
    },
  },
  "warm-executive-home-office": {
    description: "Refined home office with built-in shelves, linen curtains, and warm wood.",
    width: 1280,
    height: 720,
    avif: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/warm-executive-home-office.4845bdfa8d05.avif",
      filename: "warm-executive-home-office.4845bdfa8d05.avif",
      mimeType: "image/avif",
      bytes: 25471,
      sha256Prefix: "4845bdfa8d05",
    },
    webp: {
      url: "https://assets.chalkmeet.com/ui/backgrounds/warm-executive-home-office.53e4fce337d3.webp",
      filename: "warm-executive-home-office.53e4fce337d3.webp",
      mimeType: "image/webp",
      bytes: 41678,
      sha256Prefix: "53e4fce337d3",
    },
  },
} as const satisfies Record<string, ChalkBackgroundAsset>;

export const CHALK_SOUND_ASSETS = {
  click: {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/click.a9f7aa4d4b04.opus",
      filename: "click.a9f7aa4d4b04.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 10116,
      sha256Prefix: "a9f7aa4d4b04",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/click.b6e7623500a8.mp3",
      filename: "click.b6e7623500a8.mp3",
      mimeType: "audio/mpeg",
      bytes: 18408,
      sha256Prefix: "b6e7623500a8",
    },
  },
  error: {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/error.a7079dfbc9af.opus",
      filename: "error.a7079dfbc9af.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 8544,
      sha256Prefix: "a7079dfbc9af",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/error.2cfe8b225499.mp3",
      filename: "error.2cfe8b225499.mp3",
      mimeType: "audio/mpeg",
      bytes: 12452,
      sha256Prefix: "2cfe8b225499",
    },
  },
  "hand-raise": {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/hand-raise.6483a6979a1f.opus",
      filename: "hand-raise.6483a6979a1f.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 5028,
      sha256Prefix: "6483a6979a1f",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/hand-raise.e8bbf2a0f91d.mp3",
      filename: "hand-raise.e8bbf2a0f91d.mp3",
      mimeType: "audio/mpeg",
      bytes: 6966,
      sha256Prefix: "e8bbf2a0f91d",
    },
  },
  join: {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/join.dbf745b208f0.opus",
      filename: "join.dbf745b208f0.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 5971,
      sha256Prefix: "dbf745b208f0",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/join.dd5dd946a7a9.mp3",
      filename: "join.dd5dd946a7a9.mp3",
      mimeType: "audio/mpeg",
      bytes: 9317,
      sha256Prefix: "dd5dd946a7a9",
    },
  },
  leave: {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/leave.4ed50303ad96.opus",
      filename: "leave.4ed50303ad96.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 4117,
      sha256Prefix: "4ed50303ad96",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/leave.33a9e1f6e7bc.mp3",
      filename: "leave.33a9e1f6e7bc.mp3",
      mimeType: "audio/mpeg",
      bytes: 5712,
      sha256Prefix: "33a9e1f6e7bc",
    },
  },
  message: {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/message.f873d7cbc5c9.opus",
      filename: "message.f873d7cbc5c9.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 2745,
      sha256Prefix: "f873d7cbc5c9",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/message.6e0e07daf817.mp3",
      filename: "message.6e0e07daf817.mp3",
      mimeType: "audio/mpeg",
      bytes: 4615,
      sha256Prefix: "6e0e07daf817",
    },
  },
  nudge: {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/nudge.25bb7ebd3bfb.opus",
      filename: "nudge.25bb7ebd3bfb.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 5538,
      sha256Prefix: "25bb7ebd3bfb",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/nudge.b3b0ad97e1b5.mp3",
      filename: "nudge.b3b0ad97e1b5.mp3",
      mimeType: "audio/mpeg",
      bytes: 7123,
      sha256Prefix: "b3b0ad97e1b5",
    },
  },
  reaction: {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/reaction.cd7dae2a78ff.opus",
      filename: "reaction.cd7dae2a78ff.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 2913,
      sha256Prefix: "cd7dae2a78ff",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/reaction.a7dd46b3203e.mp3",
      filename: "reaction.a7dd46b3203e.mp3",
      mimeType: "audio/mpeg",
      bytes: 5086,
      sha256Prefix: "a7dd46b3203e",
    },
  },
  "recording-start": {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/recording-start.25fb011fb392.opus",
      filename: "recording-start.25fb011fb392.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 7293,
      sha256Prefix: "25fb011fb392",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/recording-start.5345b5de7c4a.mp3",
      filename: "recording-start.5345b5de7c4a.mp3",
      mimeType: "audio/mpeg",
      bytes: 12452,
      sha256Prefix: "5345b5de7c4a",
    },
  },
  "recording-stop": {
    opus: {
      url: "https://assets.chalkmeet.com/ui/sounds/recording-stop.9dd31b4946cd.opus",
      filename: "recording-stop.9dd31b4946cd.opus",
      mimeType: "audio/ogg; codecs=opus",
      bytes: 7880,
      sha256Prefix: "9dd31b4946cd",
    },
    mp3: {
      url: "https://assets.chalkmeet.com/ui/sounds/recording-stop.a53ec340bdb5.mp3",
      filename: "recording-stop.a53ec340bdb5.mp3",
      mimeType: "audio/mpeg",
      bytes: 12452,
      sha256Prefix: "a53ec340bdb5",
    },
  },
} as const satisfies Record<string, ChalkSoundAsset>;

export const CHALK_LOGO_FILES = {
  logo: "chalk-logo.svg",
  icon: "chalk-icon.svg",
} as const;

export const chalkAssets = {
  baseUrl: CHALK_ASSET_CDN_BASE_URL,
  manifestUrl: CHALK_ASSET_MANIFEST_URL,
  cachePolicy: CHALK_ASSET_CACHE_POLICY,
  backgrounds: CHALK_BACKGROUND_ASSETS,
  sounds: CHALK_SOUND_ASSETS,
  logos: CHALK_LOGO_FILES,
} as const;
