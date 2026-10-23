// @vitest-environment happy-dom
// Native has no component renderer. Use web host elements only at its platform boundary.
import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CallOverlays } from "../../../react-native/src/status/CallOverlays";
import { frameRegions } from "../../../react-native/src/frame/regions";

const state = vi.hoisted((): { top: number; arrangement: "portrait" | "landscape" | "pad" } => ({ top: 59, arrangement: "portrait" }));
vi.mock("../../../react-native/node_modules/react-native", () => ({
  StyleSheet: { absoluteFill: {} },
  View: ({ children, style, testID, pointerEvents }: { children: ReactNode; style: CSSProperties; testID?: string; pointerEvents: string }) => (
    <div data-testid={testID} data-pointer-events={pointerEvents} style={style}>
      {children}
    </div>
  ),
}));
vi.mock("../../../react-native/src/frame/device-layout", () => ({ useDeviceLayout: () => ({ arrangement: state.arrangement, width: 393, height: 852, insets: { top: state.top, bottom: 34, left: 0, right: 0 } }) }));
vi.mock("../../../react-native/src/frame/back-handler", () => ({ useBackHandler: () => {} }));
vi.mock("../../../react-native/src/hooks/space-hooks", () => ({ useConnection: () => ({ syncHealth: "degraded" }), useRecording: () => ({}), useChat: () => ({ pendingSends: [] }) }));
vi.mock("../../../react-native/src/primitives/ChalkText", () => ({ ChalkText: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("../../../react-native/src/limbo/Limbo", () => ({ Limbo: () => <div data-limbo /> }));
vi.mock("../../../react-native/src/limbo/Veil", () => ({ Veil: ({ level }: { level: string }) => <div data-veil={level} /> }));
vi.mock("../../../react-native/src/primitives/toast/ToastStack", () => ({ useToasts: () => ({ clear: () => {} }) }));
vi.mock("../../../react-native/src/theme/theme", () => ({ useTheme: () => ({ colors: { surface: "white" } }) }));
vi.mock("../../../react-native/src/status/StatusPage", () => ({ StatusPage: () => null }));

it.each(["portrait", "landscape", "pad"] as const)("keeps native notices below the inset-aware %s header without a veil", (arrangement) => {
  state.arrangement = arrangement;
  for (const top of [0, 24, 59]) {
    state.top = top;
    for (const kind of ["reconnecting", "call"] as const) {
      const container = document.createElement("div");
      container.innerHTML = renderToStaticMarkup(<CallOverlays screen={{ kind }} callName="Call" rejoining={false} onHold={false} onRejoin={() => {}} onHome={() => {}} />);
      const notice = container.querySelector('[data-testid="connection.notice"]');
      if (!(notice instanceof HTMLElement)) throw new Error("Missing native connection notice");
      const { header } = frameRegions(arrangement, 393, 852, { top, bottom: 34, left: 0, right: 0 });
      expect(Number.parseFloat(notice.style.top)).toBeGreaterThanOrEqual(header.y + header.height);
      expect(notice.dataset.pointerEvents).toBe("none");
      expect(container.querySelector('[data-veil="none"]')).not.toBeNull();
      expect(container.querySelector("[data-limbo]")).toBeNull();
    }
  }
});
