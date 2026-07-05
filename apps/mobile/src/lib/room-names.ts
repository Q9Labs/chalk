const ROOM_FIRST_WORDS = ["Phantom", "Button", "Cable", "Velvet", "Signal", "Paper", "Mango", "Orbit", "Cedar", "Pixel", "Harbor", "Rocket", "Echo", "Copper", "Maple", "Drift", "Solar", "Lucky", "Marble", "Bloom"] as const;
const ROOM_SECOND_WORDS = ["Tea", "Air", "Delta", "Garden", "Parade", "Canvas", "Bridge", "Comet", "Cove", "Studio", "Harbor", "Signal", "Mirror", "Meadow", "Compass", "Current", "Summit", "Lantern", "Window", "Trail"] as const;

export function createFriendlyRoomName(random: () => number = Math.random): { label: string; slug: string } {
  const firstWord = ROOM_FIRST_WORDS[Math.floor(random() * ROOM_FIRST_WORDS.length)] ?? ROOM_FIRST_WORDS[0];
  const secondWord = ROOM_SECOND_WORDS[Math.floor(random() * ROOM_SECOND_WORDS.length)] ?? ROOM_SECOND_WORDS[0];
  const label = `${firstWord} ${secondWord}`;

  return {
    label,
    slug: `${firstWord}-${secondWord}`.toLowerCase(),
  };
}

export function humanizeRoomName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Meeting Room";
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.includes(" ")) {
    return trimmed.replace(/\s+/g, " ");
  }

  if (!/^[a-z0-9_-]+$/i.test(trimmed) || !/[-_]/.test(trimmed)) {
    return trimmed;
  }

  return trimmed
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}
