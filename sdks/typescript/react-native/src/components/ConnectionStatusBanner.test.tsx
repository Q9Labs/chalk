import { Children, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));

import { ConnectionStatusBanner, deriveConnectionStatus, type ConnectionStatusSnapshot } from "./ConnectionStatusBanner";

function snapshot(overrides: Partial<ConnectionStatusSnapshot> = {}): ConnectionStatusSnapshot {
  return {
    state: "live",
    connection: { sync: "healthy", media: "healthy" },
    failure: null,
    ...overrides,
  };
}

describe("deriveConnectionStatus", () => {
  it("reports live Spaces whose sync or media connection is recovering", () => {
    expect(deriveConnectionStatus(snapshot({ connection: { sync: "healthy", media: "recovering" } }))).toEqual({ kind: "reconnecting", message: "The Space connection was interrupted. Recovering now." });
    expect(deriveConnectionStatus(snapshot({ state: "reconnecting", connection: { sync: "recovering", media: "healthy" } }))).toMatchObject({ kind: "reconnecting" });
  });

  it("reports a nonterminal recoverable connection failure for retry", () => {
    const failure: ConnectionStatusSnapshot["failure"] = { action: null, code: "media_recovery_exhausted", message: "Media needs another try", recoverable: true };

    expect(deriveConnectionStatus(snapshot({ connection: { sync: "healthy", media: "failed" }, failure }))).toEqual({ kind: "recoverable-failure", message: "Media needs another try" });
  });

  it("leaves joining and terminal failures to their lifecycle surfaces", () => {
    const failure: ConnectionStatusSnapshot["failure"] = { action: "join", code: "sync_start_failed", message: "Sync unavailable", recoverable: true };

    expect(deriveConnectionStatus(snapshot({ state: "joining", connection: { sync: "connecting", media: "connecting" } }))).toBeNull();
    expect(deriveConnectionStatus(snapshot({ state: "failed", connection: { sync: "failed", media: "failed" }, failure }))).toBeNull();
    expect(deriveConnectionStatus(snapshot())).toBeNull();
  });
});

describe("ConnectionStatusBanner", () => {
  it("announces recovery accessibly without offering a premature retry", () => {
    const element = ConnectionStatusBanner({ status: { kind: "reconnecting", message: "The Space connection was interrupted. Recovering now." }, onRetry: vi.fn() });
    const children = Children.toArray(element.props.children) as ReactElement[];
    const copy = Children.toArray(children[0]?.props.children) as ReactElement[];
    const title = Children.toArray(copy[1]?.props.children)[0] as ReactElement;

    expect(element.props.accessibilityRole).toBe("alert");
    expect(element.props.accessibilityLiveRegion).toBe("polite");
    expect(title.props.children).toBe("Reconnecting to the Space");
    expect(children).toHaveLength(1);
  });

  it("exposes a retry action for recoverable connection failures", () => {
    const onRetry = vi.fn();
    const element = ConnectionStatusBanner({ status: { kind: "recoverable-failure", message: "Media needs another try" }, onRetry });
    const children = Children.toArray(element.props.children) as ReactElement[];
    const retry = children[1];

    expect(element.props.accessibilityLiveRegion).toBe("assertive");
    expect(retry?.props.accessibilityRole).toBe("button");
    expect(retry?.props.accessibilityLabel).toBe("Retry the Space connection");
    retry?.props.onPress();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
