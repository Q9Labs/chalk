import { Facehash } from "@q9labsai/facehash/react";

// The call's eight identity colors, picked by an FNV-1a hash of the name, as the call picks them.
const IDENTITY_COLORS = ["#315F72", "#5C6650", "#6B5B4F", "#64576B", "#49645D", "#665D42", "#4D5D73", "#6D5158"] as const;

export function identityColor(name: string): string {
  let hash = 2166136261;
  for (const char of name.trim().toLowerCase() || "chalk") {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return IDENTITY_COLORS[(hash >>> 0) % IDENTITY_COLORS.length] ?? IDENTITY_COLORS[0];
}

/** A Facehash avatar. Tile avatars use the bold 3D style; small ones the subtle style. */
export function Avatar({ name, size = 28, tile = false }: { readonly name: string; readonly size?: number; readonly tile?: boolean }) {
  return (
    <span className="av" style={{ width: size, height: size }} aria-hidden="true">
      <Facehash name={name} size={size} variant="solid" intensity3d={tile ? "dramatic" : "subtle"} interactive={false} enableBlink colors={[identityColor(name)]} />
    </span>
  );
}

/** Up to `max` overlapping faces, then a count of the rest. */
export function Faces({ names, size = 28, max = 3 }: { readonly names: readonly string[]; readonly size?: number; readonly max?: number }) {
  return (
    <span className="faces">
      {names.slice(0, max).map((name, index) => (
        // Two people can share a name, so the position keeps the keys apart.
        <Avatar key={`${index}:${name}`} name={name} size={size} />
      ))}
      {names.length > max ? <span className="more num">+{names.length - max}</span> : null}
    </span>
  );
}
