export function usePwaInstall() {
  return { canInstall: false, install: async () => false };
}
