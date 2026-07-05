export type WhatsNewData = any;
export function useWhatsNew(): any {
  return { isOpen: false, open: () => {}, close: () => {}, markSeen: () => {}, data: null };
}
