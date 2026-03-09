/**
 * DeviceSelector - Modal picker for camera/microphone devices
 */

import { useCallback } from "react";
import { FlatList, Modal, StyleSheet, Text, TouchableOpacity, View, type ViewStyle } from "react-native";
import type { MediaDevice } from "@q9labs/chalk-core";
import { CHALK_THEME } from "../../theme";
import { CheckIcon, CloseIcon } from "../../icons";

interface DeviceSelectorProps {
  /** Whether the modal is visible */
  visible: boolean;
  /** List of available devices */
  devices: MediaDevice[];
  /** Currently selected device ID */
  selectedId?: string;
  /** Callback when a device is selected */
  onSelect: (deviceId: string) => void;
  /** Callback to close the modal without selection */
  onClose: () => void;
  /** Type of device being selected */
  type: "video" | "audio";
  /** Additional container styles */
  style?: ViewStyle;
}

function DeviceRow({ device, isSelected, onPress }: { device: MediaDevice; isSelected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.deviceRow, isSelected && styles.deviceRowSelected]} onPress={onPress} activeOpacity={0.7}>
      <Text style={[styles.deviceName, isSelected && styles.deviceNameSelected]} numberOfLines={1}>
        {device.label || `Device ${device.deviceId.slice(0, 8)}`}
      </Text>
      {isSelected && <CheckIcon size={18} color={CHALK_THEME.colors.primary} />}
    </TouchableOpacity>
  );
}

export function DeviceSelector({ visible, devices, selectedId, onSelect, onClose, type, style }: DeviceSelectorProps) {
  const title = type === "video" ? "Select Camera" : "Select Microphone";

  const handleSelect = useCallback(
    (deviceId: string) => {
      onSelect(deviceId);
      onClose();
    },
    [onSelect, onClose],
  );

  const renderDevice = useCallback(({ item }: { item: MediaDevice }) => <DeviceRow device={item} isSelected={item.deviceId === selectedId} onPress={() => handleSelect(item.deviceId)} />, [selectedId, handleSelect]);

  const keyExtractor = useCallback((item: MediaDevice) => item.deviceId, []);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={[styles.container, style]}>
          <TouchableOpacity activeOpacity={1}>
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.title}>{title}</Text>
              <TouchableOpacity style={styles.closeButton} onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <CloseIcon size={16} color={CHALK_THEME.colors.text.muted} />
              </TouchableOpacity>
            </View>

            {/* Device list */}
            {devices.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No devices available</Text>
              </View>
            ) : (
              <FlatList data={devices} renderItem={renderDevice} keyExtractor={keyExtractor} style={styles.list} showsVerticalScrollIndicator={false} />
            )}
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: CHALK_THEME.colors.ui.overlay,
    justifyContent: "center",
    alignItems: "center",
    padding: CHALK_THEME.spacing.lg,
  },
  container: {
    backgroundColor: CHALK_THEME.colors.background,
    borderRadius: CHALK_THEME.borderRadius.lg,
    width: "100%",
    maxWidth: 400,
    maxHeight: "80%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: CHALK_THEME.colors.ui.border,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: CHALK_THEME.spacing.lg,
    paddingVertical: CHALK_THEME.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: CHALK_THEME.colors.ui.border,
  },
  title: {
    fontSize: CHALK_THEME.typography.sizes.lg,
    fontWeight: "600",
    color: CHALK_THEME.colors.text.primary,
  },
  closeButton: {
    width: 28,
    height: 28,
    justifyContent: "center",
    alignItems: "center",
  },
  list: {
    maxHeight: 300,
  },
  deviceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: CHALK_THEME.spacing.lg,
    paddingVertical: CHALK_THEME.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: CHALK_THEME.colors.ui.border,
  },
  deviceRowSelected: {
    backgroundColor: CHALK_THEME.colors.ui.pillBg,
  },
  deviceName: {
    flex: 1,
    fontSize: 15,
    color: CHALK_THEME.colors.text.secondary,
    marginRight: 12,
  },
  deviceNameSelected: {
    color: CHALK_THEME.colors.primary,
    fontWeight: "500",
  },
  emptyContainer: {
    paddingVertical: 40,
    paddingHorizontal: 20,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    color: CHALK_THEME.colors.text.muted,
  },
});
