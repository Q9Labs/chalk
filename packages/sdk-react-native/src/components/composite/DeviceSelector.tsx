/**
 * DeviceSelector - Modal picker for camera/microphone devices
 */

import { useCallback } from "react";
import {
	FlatList,
	Modal,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
	type ViewStyle,
} from "react-native";
import type { MediaDevice } from "@q9labs/chalk-core";

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

function CheckIcon() {
	return (
		<View style={styles.checkIcon}>
			{/* Checkmark using two rotated lines */}
			<View style={styles.checkLong} />
			<View style={styles.checkShort} />
		</View>
	);
}

function DeviceRow({
	device,
	isSelected,
	onPress,
}: {
	device: MediaDevice;
	isSelected: boolean;
	onPress: () => void;
}) {
	return (
		<TouchableOpacity
			style={[styles.deviceRow, isSelected && styles.deviceRowSelected]}
			onPress={onPress}
			activeOpacity={0.7}
		>
			<Text
				style={[styles.deviceName, isSelected && styles.deviceNameSelected]}
				numberOfLines={1}
			>
				{device.label || `Device ${device.deviceId.slice(0, 8)}`}
			</Text>
			{isSelected && <CheckIcon />}
		</TouchableOpacity>
	);
}

export function DeviceSelector({
	visible,
	devices,
	selectedId,
	onSelect,
	onClose,
	type,
	style,
}: DeviceSelectorProps) {
	const title = type === "video" ? "Select Camera" : "Select Microphone";

	const handleSelect = useCallback(
		(deviceId: string) => {
			onSelect(deviceId);
			onClose();
		},
		[onSelect, onClose],
	);

	const renderDevice = useCallback(
		({ item }: { item: MediaDevice }) => (
			<DeviceRow
				device={item}
				isSelected={item.deviceId === selectedId}
				onPress={() => handleSelect(item.deviceId)}
			/>
		),
		[selectedId, handleSelect],
	);

	const keyExtractor = useCallback((item: MediaDevice) => item.deviceId, []);

	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={onClose}
		>
			<TouchableOpacity
				style={styles.overlay}
				activeOpacity={1}
				onPress={onClose}
			>
				<View style={[styles.container, style]}>
					<TouchableOpacity activeOpacity={1}>
						{/* Header */}
						<View style={styles.header}>
							<Text style={styles.title}>{title}</Text>
							<TouchableOpacity
								style={styles.closeButton}
								onPress={onClose}
								hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
							>
								<View style={styles.closeX}>
									<View style={styles.closeLine1} />
									<View style={styles.closeLine2} />
								</View>
							</TouchableOpacity>
						</View>

						{/* Device list */}
						{devices.length === 0 ? (
							<View style={styles.emptyContainer}>
								<Text style={styles.emptyText}>No devices available</Text>
							</View>
						) : (
							<FlatList
								data={devices}
								renderItem={renderDevice}
								keyExtractor={keyExtractor}
								style={styles.list}
								showsVerticalScrollIndicator={false}
							/>
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
		backgroundColor: "rgba(0, 0, 0, 0.5)",
		justifyContent: "center",
		alignItems: "center",
		padding: 24,
	},
	container: {
		backgroundColor: "#ffffff",
		borderRadius: 16,
		width: "100%",
		maxWidth: 400,
		maxHeight: "80%",
		overflow: "hidden",
	},
	header: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 20,
		paddingVertical: 16,
		borderBottomWidth: 1,
		borderBottomColor: "#e5e7eb", // gray-200
	},
	title: {
		fontSize: 18,
		fontWeight: "600",
		color: "#1f2937", // gray-800
	},
	closeButton: {
		width: 28,
		height: 28,
		justifyContent: "center",
		alignItems: "center",
	},
	closeX: {
		width: 16,
		height: 16,
		justifyContent: "center",
		alignItems: "center",
	},
	closeLine1: {
		position: "absolute",
		width: 16,
		height: 2,
		backgroundColor: "#6b7280", // gray-500
		transform: [{ rotate: "45deg" }],
	},
	closeLine2: {
		position: "absolute",
		width: 16,
		height: 2,
		backgroundColor: "#6b7280", // gray-500
		transform: [{ rotate: "-45deg" }],
	},
	list: {
		maxHeight: 300,
	},
	deviceRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 20,
		paddingVertical: 14,
		borderBottomWidth: 1,
		borderBottomColor: "#f3f4f6", // gray-100
	},
	deviceRowSelected: {
		backgroundColor: "#eff6ff", // blue-50
	},
	deviceName: {
		flex: 1,
		fontSize: 15,
		color: "#374151", // gray-700
		marginRight: 12,
	},
	deviceNameSelected: {
		color: "#2563eb", // blue-600
		fontWeight: "500",
	},
	checkIcon: {
		width: 20,
		height: 20,
		justifyContent: "center",
		alignItems: "center",
	},
	checkLong: {
		position: "absolute",
		width: 12,
		height: 2,
		backgroundColor: "#2563eb", // blue-600
		transform: [{ rotate: "45deg" }, { translateX: 2 }, { translateY: 2 }],
	},
	checkShort: {
		position: "absolute",
		width: 6,
		height: 2,
		backgroundColor: "#2563eb", // blue-600
		transform: [{ rotate: "-45deg" }, { translateX: -3 }, { translateY: 3 }],
	},
	emptyContainer: {
		paddingVertical: 40,
		paddingHorizontal: 20,
		alignItems: "center",
	},
	emptyText: {
		fontSize: 14,
		color: "#9ca3af", // gray-400
	},
});
