import { createContext, Fragment, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/** Layers above the call, bottom to top. Sheets sit under the limbo and status overlays; menus and toasts sit above everything. */
export type PortalLayer = "sheets" | "menus" | "toasts";

type Entry = { readonly key: number; readonly node: ReactNode };

type PortalStore = {
  readonly set: (layer: PortalLayer, key: number, node: ReactNode) => void;
  readonly remove: (layer: PortalLayer, key: number) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly entries: (layer: PortalLayer) => readonly Entry[];
};

function createPortalStore(): PortalStore {
  let layers: Readonly<Record<PortalLayer, readonly Entry[]>> = { sheets: [], menus: [], toasts: [] };
  const listeners = new Set<() => void>();
  const publish = (layer: PortalLayer, next: readonly Entry[]) => {
    layers = { ...layers, [layer]: next };
    for (const listener of listeners) listener();
  };
  return {
    set(layer, key, node) {
      const current = layers[layer];
      const index = current.findIndex((entry) => entry.key === key);
      publish(layer, index < 0 ? [...current, { key, node }] : current.map((entry) => (entry.key === key ? { key, node } : entry)));
    },
    remove(layer, key) {
      publish(
        layer,
        layers[layer].filter((entry) => entry.key !== key),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    entries: (layer) => layers[layer],
  };
}

const PortalContext = createContext<PortalStore | null>(null);

export function PortalProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [store] = useState(createPortalStore);
  return <PortalContext.Provider value={store}>{children}</PortalContext.Provider>;
}

function usePortalStore(): PortalStore {
  const store = useContext(PortalContext);
  if (!store) throw new Error("Chalk portals must be rendered inside <Chalk>.");
  return store;
}

let nextKey = 0;

/**
 * Renders its children in one of the frame's layers, so a sheet or menu opened deep in the tree
 * draws above the whole call. Context providers between `<Chalk>` and the portal don't reach the
 * children; pass what they need as props.
 */
export function Portal({ layer, children }: { readonly layer: PortalLayer; readonly children: ReactNode }): null {
  const store = usePortalStore();
  const key = useRef(-1);
  if (key.current < 0) key.current = nextKey++;
  useLayoutEffect(() => {
    store.set(layer, key.current, children);
  });
  useLayoutEffect(() => {
    const own = key.current;
    return () => store.remove(layer, own);
  }, [layer, store]);
  return null;
}

export function PortalHost({ layer }: { readonly layer: PortalLayer }): React.JSX.Element {
  const entries = usePortalEntries(layer);
  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.key}>{entry.node}</Fragment>
      ))}
    </>
  );
}

export function usePortalEntries(layer: PortalLayer): readonly Entry[] {
  const store = usePortalStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.entries(layer),
    () => store.entries(layer),
  );
}
