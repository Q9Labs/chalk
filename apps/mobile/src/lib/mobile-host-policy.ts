export function isMobileHostCreationEnabled({ isDevRuntime, hasConfiguredHostKey, canBootstrapLocalHost }: { isDevRuntime: boolean; hasConfiguredHostKey: boolean; canBootstrapLocalHost: boolean }): boolean {
  return isDevRuntime && (hasConfiguredHostKey || canBootstrapLocalHost);
}
