export interface NativeMeetingPageStore {
  getSnapshot(): number;
  subscribe(listener: () => void): () => void;
  setPage(page: number): void;
  clampToPageCount(pageCount: number): void;
}

export function createNativeMeetingPageStore(): NativeMeetingPageStore {
  let page = 0;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => page,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPage: (nextPage) => {
      const nextPageIndex = Math.max(0, nextPage);
      if (nextPageIndex === page) {
        return;
      }

      page = nextPageIndex;
      for (const listener of listeners) {
        listener();
      }
    },
    clampToPageCount: (pageCount) => {
      const nextPageIndex = Math.min(page, Math.max(0, pageCount - 1));
      if (nextPageIndex === page) {
        return;
      }

      page = nextPageIndex;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
