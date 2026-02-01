/**
 * ChatPanel - Message list with input for chat functionality
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	FlatList,
	Keyboard,
	KeyboardAvoidingView,
	Platform,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
	type ViewStyle,
} from "react-native";
import type { ChatMessage } from "@q9labs/chalk-core";
import { CHALK_THEME } from "../../theme";
import { SendIcon } from "../../icons";

interface ChatPanelProps {
	/** Array of chat messages to display */
	messages: ChatMessage[];
	/** Callback when user sends a message */
	onSend: (text: string) => void;
	/** ID of the local user to distinguish own messages */
	localUserId?: string;
	/** Additional container styles */
	style?: ViewStyle;
}

function formatTime(date: Date) {
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const ampm = hours >= 12 ? "PM" : "AM";
	const h = hours % 12 || 12;
	const m = minutes < 10 ? `0${minutes}` : minutes;
	return `${h}:${m} ${ampm}`;
}

function MessageBubble({
	message,
	isLocal,
}: {
	message: ChatMessage;
	isLocal: boolean;
}) {
	return (
		<View
			style={[
				styles.messageBubble,
				isLocal ? styles.localBubble : styles.remoteBubble,
			]}
		>
			{!isLocal && <Text style={styles.senderName}>{message.senderName}</Text>}
			<Text style={[styles.messageText, isLocal && styles.localMessageText]}>
				{message.content}
			</Text>
			<Text style={[styles.timestamp, isLocal && styles.localTimestamp]}>
				{formatTime(message.timestamp)}
			</Text>
		</View>
	);
}

export function ChatPanel({
	messages,
	onSend,
	localUserId,
	style,
}: ChatPanelProps) {
	const [inputText, setInputText] = useState("");
	const flatListRef = useRef<FlatList<ChatMessage>>(null);

	// Auto-scroll to bottom when new messages arrive
	useEffect(() => {
		if (messages.length > 0 && flatListRef.current) {
			// Small delay to ensure layout is complete
			const timeout = setTimeout(() => {
				flatListRef.current?.scrollToEnd({ animated: true });
			}, 100);
			return () => clearTimeout(timeout);
		}
	}, [messages.length]);

	const handleSend = useCallback(() => {
		const trimmed = inputText.trim();
		if (trimmed.length === 0) return;
		onSend(trimmed);
		setInputText("");
		Keyboard.dismiss();
	}, [inputText, onSend]);

	const renderMessage = useCallback(
		({ item }: { item: ChatMessage }) => {
			const isLocal = localUserId ? item.senderId === localUserId : false;
			return <MessageBubble message={item} isLocal={isLocal} />;
		},
		[localUserId],
	);

	const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

	const isDisabled = inputText.trim().length === 0;

	return (
		<KeyboardAvoidingView
			style={[styles.container, style]}
			behavior={Platform.OS === "ios" ? "padding" : "height"}
			keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
		>
			<FlatList
				ref={flatListRef}
				data={messages}
				renderItem={renderMessage}
				keyExtractor={keyExtractor}
				contentContainerStyle={styles.messageList}
				showsVerticalScrollIndicator={false}
				keyboardShouldPersistTaps="handled"
				ListEmptyComponent={
					<View style={styles.emptyContainer}>
						<Text style={styles.emptyText}>No messages yet</Text>
					</View>
				}
			/>
			<View style={styles.inputContainer}>
				<TextInput
					style={styles.input}
					value={inputText}
					onChangeText={setInputText}
					placeholder="Type a message..."
					placeholderTextColor={CHALK_THEME.colors.text.muted}
					returnKeyType="send"
					onSubmitEditing={handleSend}
					blurOnSubmit={false}
				/>
				<TouchableOpacity
					style={[
						styles.sendButton,
						isDisabled && styles.sendButtonDisabled,
					]}
					onPress={handleSend}
					disabled={isDisabled}
					activeOpacity={0.7}
				>
					<SendIcon size={20} color={CHALK_THEME.colors.text.inverse} />
				</TouchableOpacity>
			</View>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: CHALK_THEME.colors.background,
	},
	messageList: {
		paddingHorizontal: CHALK_THEME.spacing.md,
		paddingVertical: CHALK_THEME.spacing.md,
		flexGrow: 1,
	},
	messageBubble: {
		maxWidth: "80%",
		paddingHorizontal: CHALK_THEME.spacing.md,
		paddingVertical: CHALK_THEME.spacing.sm,
		borderRadius: CHALK_THEME.borderRadius.lg,
		marginBottom: CHALK_THEME.spacing.sm,
	},
	localBubble: {
		alignSelf: "flex-end",
		backgroundColor: CHALK_THEME.colors.primary,
		borderBottomRightRadius: CHALK_THEME.borderRadius.sm,
	},
	remoteBubble: {
		alignSelf: "flex-start",
		backgroundColor: CHALK_THEME.colors.surface,
		borderBottomLeftRadius: CHALK_THEME.borderRadius.sm,
	},
	senderName: {
		fontSize: CHALK_THEME.typography.sizes.xs,
		fontWeight: "600",
		color: CHALK_THEME.colors.text.secondary,
		marginBottom: 2,
	},
	messageText: {
		fontSize: 15,
		color: CHALK_THEME.colors.text.primary,
		lineHeight: 20,
	},
	localMessageText: {
		color: CHALK_THEME.colors.text.inverse,
	},
	timestamp: {
		fontSize: 10,
		color: CHALK_THEME.colors.text.muted,
		marginTop: 4,
		alignSelf: "flex-end",
	},
	localTimestamp: {
		color: "rgba(15, 23, 42, 0.6)", // Darker text on light primary
	},
	emptyContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		paddingVertical: 40,
	},
	emptyText: {
		fontSize: CHALK_THEME.typography.sizes.sm,
		color: CHALK_THEME.colors.text.muted,
	},
	inputContainer: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: CHALK_THEME.spacing.md,
		paddingVertical: CHALK_THEME.spacing.sm,
		borderTopWidth: 1,
		borderTopColor: CHALK_THEME.colors.ui.border,
		backgroundColor: CHALK_THEME.colors.background,
	},
	input: {
		flex: 1,
		minHeight: 40,
		maxHeight: 100,
		paddingHorizontal: CHALK_THEME.spacing.md,
		paddingVertical: CHALK_THEME.spacing.sm,
		backgroundColor: CHALK_THEME.colors.ui.pillBg,
		borderRadius: CHALK_THEME.borderRadius.xl,
		fontSize: 15,
		color: CHALK_THEME.colors.text.primary,
	},
	sendButton: {
		width: 40,
		height: 40,
		borderRadius: 20,
		backgroundColor: CHALK_THEME.colors.primary,
		justifyContent: "center",
		alignItems: "center",
		marginLeft: CHALK_THEME.spacing.sm,
	},
	sendButtonDisabled: {
		backgroundColor: CHALK_THEME.colors.ui.pillBg,
		opacity: 0.5,
	},
});
