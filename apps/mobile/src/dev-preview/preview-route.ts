import { normalizePreviewSearch, serializePreviewSearch, type PreviewSearch, type PreviewSearchPatch } from "./preview-state";

const PREVIEW_ROUTE_SCHEMES = ["chalk", "ai.q9labs.chalk.mobile", "exp+chalk-mobile"] as const;
type PreviewRouteScheme = (typeof PREVIEW_ROUTE_SCHEMES)[number];

const PREVIEW_ROUTE_HOST = "sdk-preview";

export interface PreviewRoutePolicy {
  readonly isDevRuntime: boolean;
}

export interface SdkPreviewRoute {
  readonly kind: "sdk-preview";
  readonly preview: PreviewSearch;
}

type PreviewSearchInput = PreviewSearch | PreviewSearchPatch;

function parseUrl(source: string | URL): URL | null {
  if (source instanceof URL) return source;

  try {
    return new URL(source.trim());
  } catch {
    return null;
  }
}

function isPreviewUrl(url: URL): url is URL {
  const scheme = url.protocol.slice(0, -1);
  const hostForm = url.hostname === PREVIEW_ROUTE_HOST && (url.pathname === "" || url.pathname === "/");
  const pathForm = url.hostname === "" && url.pathname === "/sdk-preview";
  return PREVIEW_ROUTE_SCHEMES.includes(scheme as PreviewRouteScheme) && (hostForm || pathForm) && !url.username && !url.password && !url.port;
}

/**
 * Parse a development-only SDK preview deep link without touching invite
 * parsing. Production runtimes intentionally treat these links as unknown.
 */
export function parsePreviewRoute(source: string | URL, policy: PreviewRoutePolicy = { isDevRuntime: false }): SdkPreviewRoute | null {
  if (!policy.isDevRuntime) return null;

  const url = parseUrl(source);
  if (!url || !isPreviewUrl(url)) return null;

  return { kind: "sdk-preview", preview: normalizePreviewSearch(url.searchParams) };
}

export function isPreviewRoute(source: string | URL, policy: PreviewRoutePolicy = { isDevRuntime: false }): boolean {
  return parsePreviewRoute(source, policy) !== null;
}

/** Build a deterministic native deep link for a normalized or partial preview state. */
export function createPreviewDeepLink(search: PreviewSearchInput = {}, scheme: PreviewRouteScheme = "chalk"): string {
  const query = serializePreviewSearch(search);
  return `${scheme}://${PREVIEW_ROUTE_HOST}${query ? `?${query}` : ""}`;
}
