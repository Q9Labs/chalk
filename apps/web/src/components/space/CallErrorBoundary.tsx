import { Component, type ReactNode } from "react";

/** Reports a render crash, then shows a way back in, so the person is not left with a blank page. */
export class CallErrorBoundary extends Component<{ readonly onCrash: (error: Error) => void; readonly onFallbackShown?: () => (() => void) | void; readonly children: ReactNode }, { readonly crashed: boolean }> {
  override state = { crashed: false };
  #dismissSurface: (() => void) | void;

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  override componentDidCatch(error: Error) {
    this.props.onCrash(error);
  }

  override componentDidUpdate(_previous: Readonly<{ onCrash: (error: Error) => void }>, previousState: Readonly<{ crashed: boolean }>) {
    if (!previousState.crashed && this.state.crashed && this.#dismissSurface === undefined && document.visibilityState === "visible") this.#dismissSurface = this.props.onFallbackShown?.();
  }

  override componentWillUnmount() {
    this.#dismissSurface?.();
  }

  override render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p>Something went wrong with the call.</p>
        <button type="button" onClick={() => globalThis.location.reload()}>
          Reload to rejoin
        </button>
      </div>
    );
  }
}
