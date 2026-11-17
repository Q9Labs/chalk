import { Component, type ReactNode } from "react";

/** Reports a render crash, then shows a way back in, so the person is not left with a blank page. */
export class CallErrorBoundary extends Component<{ readonly onCrash: () => void; readonly children: ReactNode }, { readonly crashed: boolean }> {
  override state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  override componentDidCatch() {
    this.props.onCrash();
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
