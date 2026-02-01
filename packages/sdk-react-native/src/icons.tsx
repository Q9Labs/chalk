/**
 * Centralized icon exports using LineIcons
 * @see https://lineicons.com/docs/integrations/react-native
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { Lineicons } = require("@lineiconshq/react-native-lineicons") as { Lineicons: any };
const freeIcons = require("@lineiconshq/free-icons") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { CHALK_THEME } from "./theme";

interface IconProps {
	size?: number;
	color?: string;
	strokeWidth?: number;
}

const DEFAULT_SIZE = 24;
const DEFAULT_COLOR = CHALK_THEME.colors.text.primary;
const DEFAULT_STROKE = 1.5;

function FallbackIcon({
	label,
	size,
	color,
}: {
	label: string;
	size: number;
	color: string;
}) {
	return (
		<View style={{ width: size, height: size, justifyContent: "center", alignItems: "center" }}>
			<Text style={[styles.fallback, { fontSize: size * 0.5, color }]}>
				{label}
			</Text>
		</View>
	);
}

/**
 * Error boundary that catches native module crashes (e.g. when
 * react-native-svg isn't linked) and shows a text fallback.
 */
class IconErrorBoundary extends React.Component<
	{ fallbackLabel: string; size: number; color: string; children: React.ReactNode },
	{ hasError: boolean }
> {
	override state = { hasError: false };

	static getDerivedStateFromError() {
		return { hasError: true };
	}

	override render() {
		if (this.state.hasError) {
			return (
				<FallbackIcon
					label={this.props.fallbackLabel}
					size={this.props.size}
					color={this.props.color}
				/>
			);
		}
		return this.props.children;
	}
}

function RenderIcon({
	icon,
	fallbackLabel,
	size,
	color,
	strokeWidth,
}: {
	icon: unknown;
	fallbackLabel: string;
	size: number;
	color: string;
	strokeWidth: number;
}) {
	if (!Lineicons) {
		return <FallbackIcon label={fallbackLabel} size={size} color={color} />;
	}
	return (
		<IconErrorBoundary fallbackLabel={fallbackLabel} size={size} color={color}>
			<Lineicons
				icon={icon}
				size={size}
				color={color}
				strokeWidth={strokeWidth}
			/>
		</IconErrorBoundary>
	);
}

export function MicrophoneIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.Microphone1Stroke}
			fallbackLabel="MIC"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function VideoIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.CameraMovie1Stroke}
			fallbackLabel="VID"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function ScreenShareIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.MonitorStroke}
			fallbackLabel="SCR"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function ChatIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.ChatBubble2Stroke}
			fallbackLabel="CHAT"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function PhoneIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.PhoneStroke}
			fallbackLabel="CALL"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function CheckIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.CheckStroke}
			fallbackLabel="OK"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function CloseIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.XmarkStroke}
			fallbackLabel="X"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function SendIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.ArrowRightStroke}
			fallbackLabel="GO"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function HandRaisedIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.HandStopStroke}
			fallbackLabel="HAND"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function SpeakingIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.VolumeHighStroke}
			fallbackLabel="VOL"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function MutedIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.VolumeMuteStroke}
			fallbackLabel="MUTE"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function SwitchCameraIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.RefreshCircle1ClockwiseStroke}
			fallbackLabel="SWAP"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

export function CameraIcon({
	size = DEFAULT_SIZE,
	color = DEFAULT_COLOR,
	strokeWidth = DEFAULT_STROKE,
}: IconProps) {
	return (
		<RenderIcon
			icon={freeIcons.Camera1Stroke}
			fallbackLabel="CAM"
			size={size}
			color={color}
			strokeWidth={strokeWidth}
		/>
	);
}

const styles = StyleSheet.create({
	fallback: {
		fontWeight: "700",
		textAlign: "center",
	},
});
