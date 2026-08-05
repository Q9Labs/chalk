import CheckmarkCircle01Icon from "@hugeicons/core-free-icons/dist/esm/CheckmarkCircle01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Speaker01Icon from "@hugeicons/core-free-icons/dist/esm/Speaker01Icon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useEffect, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Theme } from "../../ui/theme";
import { CloseButton, IconTile, SheetGrip } from "./SpaceSurfacePrimitives";
import type { SpaceController } from "./space-progressive-surface-types";
import { AppearanceSettings } from "./AppearanceSettings";

type SettingsTab = "devices" | "appearance" | "space";

export function SettingsSheet({ controller, isOpen, onClose }: { readonly controller: SpaceController; readonly isOpen: boolean; readonly onClose: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>("devices");

  useEffect(() => {
    if (!isOpen) setTab("devices");
  }, [isOpen]);

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={isOpen}>
      <View style={styles.modalRoot}>
        <Pressable accessibilityLabel="Close Settings" onPress={onClose} style={styles.backdrop} />
        <View style={styles.sheet}>
          <SheetGrip />
          <View style={styles.header}>
            <Text style={styles.title}>Settings</Text>
            <CloseButton label="Close Settings" onPress={onClose} />
          </View>
          <View accessibilityRole="tablist" style={styles.tabs}>
            {(["devices", "appearance", "space"] as const).map((nextTab) => (
              <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === nextTab }} key={nextTab} onPress={() => setTab(nextTab)} style={({ pressed }) => [styles.tab, tab === nextTab && styles.tabSelected, pressed && styles.pressed]}>
                <Text style={[styles.tabText, tab === nextTab && styles.tabTextSelected]}>{nextTab[0]!.toUpperCase() + nextTab.slice(1)}</Text>
              </Pressable>
            ))}
          </View>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {tab === "devices" ? <DevicesSettings controller={controller} /> : null}
            {tab === "appearance" ? <AppearanceSettings /> : null}
            {tab === "space" ? <SpaceSettings controller={controller} /> : null}
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function DevicesSettings({ controller }: { readonly controller: SpaceController }): React.JSX.Element {
  const microphoneEnabled = !controller.isMuted;
  const cameraEnabled = !controller.isCameraOff;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionIntro}>Use the controls below to set what you share in this Episode.</Text>
      <DeviceControl disabled={controller.simulatorMediaDisabled} enabled={microphoneEnabled} icon={microphoneEnabled ? Mic01Icon : MicOff01Icon} label="Microphone" onPress={controller.toggleAudio} value={microphoneEnabled ? "On" : "Off"} />
      <DeviceControl disabled={controller.simulatorMediaDisabled} enabled={cameraEnabled} icon={cameraEnabled ? Video01Icon : VideoOffIcon} label="Camera" onPress={controller.toggleVideo} value={cameraEnabled ? "On" : "Off"} />
      <View style={styles.deviceRow}>
        <IconTile icon={Speaker01Icon} />
        <View style={styles.rowCopy}>
          <Text style={styles.rowLabel}>Speaker</Text>
          <Text style={styles.rowMeta}>System audio output</Text>
        </View>
        <Text style={styles.rowValue}>Automatic</Text>
      </View>
      <View style={styles.readyCard}>
        <HugeiconsIcon color={Theme.colors.success} icon={CheckmarkCircle01Icon} size={22} />
        <Text style={styles.readyText}>{controller.simulatorMediaDisabled ? "Device controls are unavailable here" : "Devices are ready"}</Text>
      </View>
    </View>
  );
}

function DeviceControl({ disabled, enabled, icon, label, onPress, value }: { readonly disabled: boolean; readonly enabled: boolean; readonly icon: React.ComponentProps<typeof HugeiconsIcon>["icon"]; readonly label: string; readonly onPress: () => void; readonly value: string }): React.JSX.Element {
  return (
    <Pressable accessibilityLabel={`${label} ${value}`} accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.deviceRow, disabled && styles.disabled, pressed && styles.pressed]}>
      <IconTile icon={icon} color={enabled ? Theme.colors.ink : Theme.colors.error} wash={enabled ? Theme.colors.surface : Theme.colors.washPink} />
      <View style={styles.rowCopy}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowMeta}>{disabled ? "Unavailable on this device" : "Tap to change state"}</Text>
      </View>
      <Text style={[styles.rowValue, !enabled && styles.valueOff]}>{value}</Text>
    </Pressable>
  );
}

function SpaceSettings({ controller }: { readonly controller: SpaceController }): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionIntro}>Canonical information about this Space and its current Episode.</Text>
      <InfoRow label="Space" value="Current Space" />
      <InfoRow label="Episode" value={controller.formattedDuration} />
      <InfoRow label="People" value={String(controller.participantCount)} />
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>Space content stays here</Text>
        <Text style={styles.infoText}>Chat and Board content belong to this Space and remain available across Episodes.</Text>
      </View>
    </View>
  );
}

function InfoRow({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.infoValue}>
        {value || "—"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: Theme.colors.darkOverlay22 },
  sheet: {
    backgroundColor: Theme.colors.surface,
    borderColor: Theme.colors.line,
    borderTopLeftRadius: Theme.radius.xl,
    borderTopRightRadius: Theme.radius.xl,
    elevation: 8,
    flex: 1,
    marginTop: 72,
    overflow: "hidden",
    paddingBottom: Platform.OS === "ios" ? Theme.spacing.md : Theme.spacing.xs,
    shadowColor: Theme.colors.ink,
    shadowOffset: { height: -8, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 22,
  },
  header: { alignItems: "center", borderBottomColor: Theme.colors.line, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 78, paddingHorizontal: Theme.spacing.lg },
  title: { ...Theme.typography.heading, color: Theme.colors.ink },
  tabs: { backgroundColor: Theme.colors.paper2, borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, flexDirection: "row", margin: Theme.spacing.lg, padding: 3 },
  tab: { alignItems: "center", borderRadius: Theme.radius.sm, flex: 1, justifyContent: "center", minHeight: 46, paddingHorizontal: Theme.spacing.sm },
  tabSelected: { backgroundColor: Theme.colors.surface, ...Theme.shadows.sm },
  tabText: { color: Theme.colors.ink2, fontSize: 14, fontWeight: "500" },
  tabTextSelected: { color: Theme.colors.ink, fontWeight: "700" },
  content: { paddingBottom: Theme.spacing.lg, paddingHorizontal: Theme.spacing.lg },
  section: { gap: Theme.spacing.md },
  sectionIntro: { ...Theme.typography.body, color: Theme.colors.ink2, marginBottom: Theme.spacing.sm },
  deviceRow: { alignItems: "center", borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, flexDirection: "row", gap: Theme.spacing.md, minHeight: 70, padding: Theme.spacing.md },
  rowCopy: { flex: 1, minWidth: 0 },
  rowLabel: { color: Theme.colors.ink, fontSize: 16, fontWeight: "600" },
  rowMeta: { color: Theme.colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 3 },
  rowValue: { color: Theme.colors.success, fontSize: 14, fontWeight: "700" },
  valueOff: { color: Theme.colors.error },
  readyCard: { alignItems: "center", backgroundColor: Theme.colors.successBackground, borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, flexDirection: "row", gap: Theme.spacing.sm, minHeight: 58, paddingHorizontal: Theme.spacing.md },
  readyText: { color: Theme.colors.ink2, fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.52 },
  infoRow: { alignItems: "center", borderBottomColor: Theme.colors.line, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 54, paddingHorizontal: Theme.spacing.sm },
  infoValue: { color: Theme.colors.ink2, flexShrink: 1, fontSize: 15, marginLeft: Theme.spacing.md, maxWidth: "62%", textAlign: "right" },
  infoCard: { backgroundColor: Theme.colors.washBlue, borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, gap: Theme.spacing.sm, marginTop: Theme.spacing.sm, padding: Theme.spacing.md },
  infoTitle: { color: Theme.colors.ink, fontSize: 15, fontWeight: "700" },
  infoText: { color: Theme.colors.ink2, fontSize: 14, lineHeight: 20 },
  doneButton: { alignItems: "center", borderColor: Theme.colors.lineStrong, borderRadius: Theme.radius.md, borderWidth: 1, justifyContent: "center", margin: Theme.spacing.lg, minHeight: 52 },
  doneText: { color: Theme.colors.ink, fontSize: 16, fontWeight: "700" },
  pressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
});
