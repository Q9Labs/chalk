import { lazy, useState, type ComponentType } from "react";

/**
 * A code-split component whose chunk can start downloading on intent (hover, focus, press). Once the
 * chunk is in, a new mount renders it directly, so a menu opened after a hover shows its content on
 * the first frame instead of an empty popup while React suspends.
 */
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const preload = () => {
    pending ??= load().then((component) => (loaded = component));
    return pending;
  };
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
  function Preloaded(props: P) {
    // The choice is fixed per mount: switching from the lazy wrapper to the loaded component would remount it and drop its state.
    const [Component] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <Component {...props} />;
  }
  return { preload, Component: Preloaded };
}
