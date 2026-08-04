import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Theme } from "@q9labsai/chalk-react-native/theme";

import { ENTRANCE_STATES, PREVIEW_CHAT_STATES, PREVIEW_DIALOGS, PREVIEW_LAYOUTS, PREVIEW_PANELS, PREVIEW_PARTICIPANT_COUNTS, PREVIEW_PALETTES, PREVIEW_STAGES, PREVIEW_TEXTURES, PREVIEW_VIEWS, SPACE_STATES, type PreviewSearch, type PreviewSearchPatch } from "./preview-state";
import { createPreviewDeepLink } from "./preview-route";
import { stateLabel } from "./sdk-preview-fixtures";

export interface DevSdkPreviewControlsProps {
  readonly search: PreviewSearch;
  readonly onSearchChange: (patch: PreviewSearchPatch) => void;
}

const DOCK_CLEARANCE = 84;

function titleFor(value: string): string {
  const labels: Record<string, string> = {
    people: "Participants",
    participants: "Participants",
    whiteboard: "Whiteboard",
    "soft-grid": "Soft grid",
    "soft-dots": "Soft dots",
    none: "None",
  };

  return labels[value] ?? stateLabel(value as PreviewSearch["state"]);
}

function OptionChip({ label, selected, onPress }: { readonly label: string; readonly selected: boolean; readonly onPress: () => void }): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.optionPressed]}>
      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function ChoiceGroup<T extends string | number>({
  label,
  value,
  options,
  format = (option) => titleFor(String(option)),
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly format?: (option: T) => string;
  readonly onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.options}>
        {options.map((option) => (
          <OptionChip key={String(option)} label={format(option)} selected={option === value} onPress={() => onChange(option)} />
        ))}
      </View>
    </View>
  );
}

function ToggleChip({ label, value, onChange }: { readonly label: string; readonly value: boolean; readonly onChange: (value: boolean) => void }): React.JSX.Element {
  return <OptionChip label={`${label}: ${value ? "On" : "Off"}`} selected={value} onPress={() => onChange(!value)} />;
}

function StateChips({ search, onSearchChange }: DevSdkPreviewControlsProps): React.JSX.Element {
  return (
    <View style={styles.stateGroups}>
      <View style={styles.group}>
        <Text style={styles.groupLabel}>Entrance states</Text>
        <View style={styles.options}>
          {ENTRANCE_STATES.map((state) => (
            <OptionChip key={state} label={stateLabel(state)} selected={search.view === "entrance" && search.state === state} onPress={() => onSearchChange({ view: "entrance", state })} />
          ))}
        </View>
      </View>
      <View style={styles.group}>
        <Text style={styles.groupLabel}>Space states</Text>
        <View style={styles.options}>
          {SPACE_STATES.map((state) => (
            <OptionChip key={state} label={stateLabel(state)} selected={search.view === "space" && search.state === state} onPress={() => onSearchChange({ view: "space", state })} />
          ))}
        </View>
      </View>
    </View>
  );
}

export function DevSdkPreviewControls({ search, onSearchChange }: DevSdkPreviewControlsProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const chromeVisible = search.chrome === "visible";
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!chromeVisible) setSheetOpen(false);
  }, [chromeVisible]);

  const closeSheet = () => {
    setSheetOpen(false);
    onSearchChange({ chrome: "hidden" });
  };

  const openSheet = () => {
    if (!chromeVisible) onSearchChange({ chrome: "visible" });
    setSheetOpen(true);
  };

  const copyDeepLink = async () => {
    try {
      await Clipboard.setStringAsync(createPreviewDeepLink(search));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <View pointerEvents="box-none" style={[styles.collapsedWrap, { bottom: insets.bottom + DOCK_CLEARANCE }]}>
        <Pressable
          accessibilityLabel={sheetOpen ? "Hide preview controls" : chromeVisible ? "Open preview controls" : "Show preview controls"}
          accessibilityRole="button"
          accessibilityState={{ expanded: sheetOpen }}
          onPress={sheetOpen ? closeSheet : openSheet}
          style={({ pressed }) => [styles.collapsedButton, pressed && styles.optionPressed]}
          testID="dev-preview-controls-trigger"
        >
          <Text style={styles.collapsedButtonText}>{sheetOpen ? "Hide controls" : chromeVisible ? "Preview controls" : "Show controls"}</Text>
        </Pressable>
      </View>

      <Modal accessibilityViewIsModal animationType="slide" onRequestClose={closeSheet} presentationStyle="pageSheet" statusBarTranslucent transparent visible={sheetOpen}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <View style={styles.sheetHeader}>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>SDK PREVIEW</Text>
                <Text style={styles.title}>Preview controls</Text>
                <Text style={styles.subtitle}>Local fixtures only. No live Space is used.</Text>
              </View>
              <Pressable accessibilityLabel="Hide preview controls" accessibilityRole="button" onPress={closeSheet} style={styles.closeButton}>
                <Text style={styles.closeButtonText}>Done</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
              <Pressable accessibilityLabel="Copy current preview deep link" accessibilityRole="button" onPress={() => void copyDeepLink()} style={({ pressed }) => [styles.copyButton, pressed && styles.optionPressed]}>
                <Text style={styles.copyButtonText}>{copied ? "Copied current deep link" : "Copy current deep link"}</Text>
              </Pressable>
              <StateChips search={search} onSearchChange={onSearchChange} />

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>View and data</Text>
                <ChoiceGroup label="View" value={search.view} options={PREVIEW_VIEWS} onChange={(view) => onSearchChange({ view, state: view === "entrance" ? "ready" : "happy" })} />
                <ChoiceGroup label="Participants" value={search.participants} options={PREVIEW_PARTICIPANT_COUNTS} format={(count) => `${count} ${count === 1 ? "Participant" : "Participants"}`} onChange={(participants) => onSearchChange({ participants })} />
                <ChoiceGroup label="Chat data" value={search.chat} options={PREVIEW_CHAT_STATES} onChange={(chat) => onSearchChange({ chat })} />
                <ChoiceGroup label="Panel" value={search.panel} options={PREVIEW_PANELS} onChange={(panel) => onSearchChange({ panel })} />
                <ChoiceGroup label="Sheet" value={search.dialog} options={PREVIEW_DIALOGS} onChange={(dialog) => onSearchChange({ dialog })} />
                <ChoiceGroup label="Stage" value={search.stage} options={PREVIEW_STAGES} onChange={(stage) => onSearchChange({ stage })} />
                <ChoiceGroup label="Layout" value={search.layout} options={PREVIEW_LAYOUTS} onChange={(layout) => onSearchChange({ layout })} />
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Appearance and signals</Text>
                <ChoiceGroup label="Palette" value={search.palette} options={PREVIEW_PALETTES} onChange={(palette) => onSearchChange({ palette })} />
                <ChoiceGroup label="Texture" value={search.texture} options={PREVIEW_TEXTURES} onChange={(texture) => onSearchChange({ texture })} />
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Participant media</Text>
                <View style={styles.options}>
                  <ToggleChip label="Microphone" value={search.mic} onChange={(mic) => onSearchChange({ mic })} />
                  <ToggleChip label="Camera" value={search.camera} onChange={(camera) => onSearchChange({ camera })} />
                  <ToggleChip label="Raised hand" value={search.hand} onChange={(hand) => onSearchChange({ hand })} />
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  collapsedWrap: {
    position: "absolute",
    left: Theme.spacing.md,
    zIndex: 20,
  },
  collapsedButton: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#C9C8C2",
    borderRadius: 10,
    borderWidth: 1,
    elevation: 4,
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: "center",
    shadowColor: "#0C0E12",
    shadowOpacity: 0.12,
    shadowRadius: 8,
  },
  collapsedButtonText: { color: "#0C0E12", fontSize: 14, fontWeight: "700" },
  modalBackdrop: { backgroundColor: "rgba(12,14,18,0.42)", flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#FBFAF7",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "88%",
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sheetHeader: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between", gap: 12 },
  headerCopy: { flex: 1, gap: 3 },
  eyebrow: { color: "#315F72", fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
  title: { color: "#0C0E12", fontSize: 22, fontWeight: "800" },
  subtitle: { color: "#555B65", fontSize: 13, lineHeight: 18 },
  closeButton: { alignItems: "center", backgroundColor: "#F1F0EB", borderRadius: 9, minHeight: 42, justifyContent: "center", paddingHorizontal: 14 },
  closeButtonText: { color: "#0C0E12", fontSize: 14, fontWeight: "800" },
  content: { gap: 16, paddingBottom: 20, paddingTop: 16 },
  copyButton: { alignItems: "center", backgroundColor: "#E6F3F8", borderColor: "#55AAC9", borderRadius: 9, borderWidth: 1, justifyContent: "center", minHeight: 42, paddingHorizontal: 14 },
  copyButtonText: { color: "#0C0E12", fontSize: 13, fontWeight: "800" },
  section: { backgroundColor: "#FFFFFF", borderColor: "#DEDDD7", borderRadius: 14, borderWidth: 1, gap: 12, padding: 14 },
  sectionTitle: { color: "#0C0E12", fontSize: 14, fontWeight: "800" },
  stateGroups: { gap: 12 },
  group: { gap: 8 },
  groupLabel: { color: "#555B65", fontSize: 12, fontWeight: "700" },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { alignItems: "center", backgroundColor: "#FBFAF7", borderColor: "#DEDDD7", borderRadius: 9, borderWidth: 1, minHeight: 38, justifyContent: "center", paddingHorizontal: 11 },
  optionSelected: { backgroundColor: "#E6F3F8", borderColor: "#55AAC9" },
  optionPressed: { opacity: 0.72 },
  optionText: { color: "#555B65", fontSize: 12, fontWeight: "600" },
  optionTextSelected: { color: "#0C0E12", fontWeight: "800" },
});
