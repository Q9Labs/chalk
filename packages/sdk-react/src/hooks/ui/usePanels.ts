export function usePanels() {
  return { activePanel: null, openPanel: (_panel: string) => {}, closePanel: () => {}, togglePanel: (_panel: string) => {} };
}
