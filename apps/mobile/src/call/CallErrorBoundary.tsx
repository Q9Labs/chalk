import { Component, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { AppTelemetry } from "@q9labsai/chalk-client/telemetry/app";

/** Reports a render crash, then shows a way back in, so the person is not left with a dead screen. */
export class CallErrorBoundary extends Component<{ readonly telemetry: AppTelemetry; readonly onLeft?: () => void; readonly children: ReactNode }, { readonly crashed: boolean }> {
  override state = { crashed: false };
  #dismissSurface: (() => void) | void;

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  override componentDidCatch(error: Error) {
    this.props.telemetry.renderCrashed("render_error", error);
  }

  override componentDidUpdate(_previous: Readonly<object>, previousState: Readonly<{ crashed: boolean }>) {
    if (!previousState.crashed && this.state.crashed && this.#dismissSurface === undefined) this.#dismissSurface = this.props.telemetry.crashFallbackShown();
  }

  override componentWillUnmount() {
    this.#dismissSurface?.();
  }

  override render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
        <Text accessibilityRole="alert">Something went wrong with the call.</Text>
        <Pressable accessibilityRole="button" onPress={() => this.props.onLeft?.()}>
          <Text>Leave</Text>
        </Pressable>
      </View>
    );
  }
}
