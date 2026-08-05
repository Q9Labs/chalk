/**
 * Build and runtime policy for the native SDK preview.
 *
 * The preview is available only to a development JavaScript runtime. Release
 * Metro bundles use a tiny entry stub, selected from the app variant/profile,
 * so a render-time guard cannot accidentally pull the gallery into production.
 */

export interface MobileBuildProfileInput {
  readonly appVariant?: string;
  readonly easBuildProfile?: string;
  readonly nodeEnv?: string;
}

export function resolveMobileBuildProfile({ appVariant, easBuildProfile }: MobileBuildProfileInput = {}): string {
  return easBuildProfile?.trim() || appVariant?.trim() || "development";
}

export function isProductionMobileBuild(input: MobileBuildProfileInput = {}): boolean {
  if (resolveMobileBuildProfile(input) === "production") return true;
  return !input.appVariant?.trim() && !input.easBuildProfile?.trim() && input.nodeEnv?.trim() === "production";
}

export function isDevPreviewRuntime(isDevRuntime: boolean): boolean {
  return isDevRuntime;
}

export type PreviewRouteOwner = "home" | "space" | "sdk-preview";

/** Keep an active Space route mounted until its owner performs an explicit leave. */
export function canOpenDevPreviewFromRoute(routeKind: PreviewRouteOwner): boolean {
  return routeKind !== "space";
}

/** The gallery owns its chrome, so global diagnostics stay on app routes only. */
export function canShowGlobalDiagnostics(routeKind: PreviewRouteOwner): boolean {
  return routeKind !== "sdk-preview";
}
