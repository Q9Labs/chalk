export function useMobileAppRedirect(_options: any = {}): any {
  return { shouldRedirect: false, isBlocking: false, status: "idle", error: null, redirectUrl: null, dismiss: () => {} };
}
