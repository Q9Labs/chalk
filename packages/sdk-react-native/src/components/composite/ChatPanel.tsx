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

function SendIcon() {
	return (
		<View style={styles.sendIconContainer}>
			{/* Arrow pointing right */}
			<View style={styles.sendArrow} />
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
					placeholderTextColor="#9ca3af"
					returnKeyType="send"
					onSubmitEditing={handleSend}
					blurOnSubmit={false}
				/>
				<TouchableOpacity
					style={[
						styles.sendButton,
						inputText.trim().length === 0 && styles.sendButtonDisabled,
					]}
					onPress={handleSend}
					disabled={inputText.trim().length === 0}
					activeOpacity={0.7}
				>
					<SendIcon />
				</TouchableOpacity>
			</View>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#ffffff",
	},
	messageList: {
		paddingHorizontal: 16,
		paddingVertical: 12,
		flexGrow: 1,
	},
	messageBubble: {
		maxWidth: "80%",
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: 16,
		marginBottom: 8,
	},
	localBubble: {
		alignSelf: "flex-end",
		backgroundColor: "#3b82f6", // blue-500
		borderBottomRightRadius: 4,
	},
	remoteBubble: {
		alignSelf: "flex-start",
		backgroundColor: "#f3f4f6", // gray-100
		borderBottomLeftRadius: 4,
	},
	senderName: {
		fontSize: 12,
		fontWeight: "600",
		color: "#6b7280", // gray-500
		marginBottom: 2,
	},
	messageText: {
		fontSize: 15,
		color: "#1f2937", // gray-800
		lineHeight: 20,
	},
	localMessageText: {
		color: "#ffffff",
	},
	timestamp: {
		fontSize: 10,
		color: "#9ca3af", // gray-400
		marginTop: 4,
		alignSelf: "flex-end",
	},
	localTimestamp: {
		color: "rgba(255, 255, 255, 0.7)",
	},
	emptyContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		paddingVertical: 40,
	},
	emptyText: {
		fontSize: 14,
		color: "#9ca3af",
	},
	inputContainer: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderTopWidth: 1,
		borderTopColor: "#e5e7eb", // gray-200
		backgroundColor: "#ffffff",
	},
	input: {
		flex: 1,
		minHeight: 40,
		maxHeight: 100,
		paddingHorizontal: 16,
		paddingVertical: 8,
		backgroundColor: "#f3f4f6", // gray-100
		borderRadius: 20,
		fontSize: 15,
		color: "#1f2937",
	},
	sendButton: {
		width: 40,
		height: 40,
		borderRadius: 20,
		backgroundColor: "#3b82f6", // blue-500
		justifyContent: "center",
		alignItems: "center",
		marginLeft: 8,
	},
	sendButtonDisabled: {
		backgroundColor: "#d1d5db", // gray-300
	},
	sendIconContainer: {
		width: 20,
		height: 20,
		justifyContent: "center",
		alignItems: "center",
	},
	sendArrow: {
		width: 0,
		height: 0,
		borderTopWidth: 6,
		borderTopColor: "transparent",
		borderBottomWidth: 6,
		borderBottomColor: "transparent",
		borderLeftWidth: 10,
		borderLeftColor: "#ffffff",
		marginLeft: 2,
	},
});
