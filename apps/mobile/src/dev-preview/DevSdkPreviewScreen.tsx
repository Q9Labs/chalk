import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { DevSdkPreviewControls } from "./DevSdkPreviewControls";
import { EntrancePreviewSurface } from "./EntrancePreviewSurface";
import type { PreviewSearch, PreviewSearchPatch } from "./preview-state";
import { SpacePreviewSurface } from "./SpacePreviewSurface";

export interface DevSdkPreviewScreenProps {
  readonly search: PreviewSearch;
  readonly onSearchChange: (patch: PreviewSearchPatch) => void;
  readonly onClose: () => void | Promise<void>;
}

/**
 * A local, deterministic gallery for the public React Native surface.
 *
 * The screen stays mounted while the typed search value changes. Fixtures
 * receive patches instead of constructing a client or asking for device
 * access, so every state can be inspected safely from a development build.
 */
export function DevSdkPreviewScreen({ search, onSearchChange, onClose }: DevSdkPreviewScreenProps): React.JSX.Element {
  return (
    <SafeAreaView style={styles.screen} testID="dev-sdk-preview-screen">
      <StatusBar style={search.view === "space" && (search.palette === "midnight" || search.palette === "slate") ? "light" : "dark"} />
      <View style={styles.surface}>{search.view === "entrance" ? <EntrancePreviewSurface onClose={onClose} search={search} onSearchChange={onSearchChange} /> : <SpacePreviewSurface onClose={onClose} onSearchChange={onSearchChange} search={search} />}</View>
      <DevSdkPreviewControls search={search} onSearchChange={onSearchChange} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#F7F6F2", flex: 1 },
  surface: { flex: 1 },
});
