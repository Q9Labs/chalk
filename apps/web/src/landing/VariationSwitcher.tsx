import { Link } from "@tanstack/react-router";

const VARIATIONS = [
  { to: "/v1", label: "1" },
  { to: "/v2", label: "2" },
  { to: "/v3", label: "3" },
] as const;

/**
 * Floating pill that lets us flip between the three landing designs.
 * Rendered on every variation; highlights the active route.
 */
export function VariationSwitcher() {
  return (
    <nav className="vswitch" aria-label="Landing page designs">
      <span className="vswitch__label">Design</span>
      {VARIATIONS.map(({ to, label }) => (
        <Link
          key={to}
          to={to}
          className="vswitch__link"
          activeProps={{ "data-active": "true" } as never}
          aria-label={`Design ${label}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
