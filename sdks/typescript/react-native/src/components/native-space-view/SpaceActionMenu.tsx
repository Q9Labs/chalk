import type { Reaction } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { Theme } from "../../ui/theme";
import { useNativeTheme } from "../../ui/native-theme";
import type { useSpaceViewController } from "./useSpaceViewController";

type Controller = ReturnType<typeof useSpaceViewController>;

export function SpaceActionMenu({ controller }: { readonly controller: Controller }): React.JSX.Element {
  const theme = useNativeTheme();
  const actions = [
    ...(controller.canInvite ? [{ label: "Invite participants", onPress: controller.handleInviteParticipants }] : []),
    ...(controller.canParticipants ? [{ label: "Participants", onPress: () => controller.openPanel("participants") }] : []),
    ...(controller.canChat ? [{ label: "Chat", onPress: () => controller.openPanel("chat") }] : []),
    ...(controller.canScreenShare ? [{ label: controller.screenShare.isLocalSharing ? "Stop presenting" : "Present screen", onPress: controller.toggleScreenShare }] : []),
    ...(controller.canHandRaise ? [{ label: controller.handRaised ? "Lower hand" : "Raise hand", onPress: controller.toggleHand }] : []),
    ...(controller.canWhiteboard ? [{ label: controller.whiteboard.isOpen ? "Close whiteboard" : "Open whiteboard", onPress: controller.whiteboard.toggle }] : []),
    ...(controller.canReactions
      ? [
          {
            label: "Reactions",
            onPress: () => {
              controller.setActionsOpen(false);
              controller.setReactionPickerOpen(true);
            },
          },
        ]
      : []),
    ...(controller.canSettings ? [{ label: "Settings", onPress: () => controller.openPanel("settings") }] : []),
    ...(["grid", "focus", "presentation"] as const).map((layout) => ({
      label: `${layout === "grid" ? "Grid" : layout === "focus" ? "Focus" : "Presentation"} layout${controller.layout.layout === layout ? " (selected)" : ""}`,
      onPress: () => {
        controller.layout.setLayout(layout);
        controller.setActionsOpen(false);
      },
    })),
  ];
  return (
    <Modal animationType="slide" onRequestClose={() => controller.setActionsOpen(false)} transparent visible={controller.actionsOpen}>
      <Pressable onPress={() => controller.setActionsOpen(false)} style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: theme.colors.background }]}>
          <Text style={[styles.title, { color: theme.colors.foreground }]}>Space actions</Text>
          {actions.map((action) => (
            <Pressable key={action.label} onPress={action.onPress} style={({ pressed }) => [styles.action, { backgroundColor: theme.colors.card }, pressed && styles.pressed]}>
              <Text style={[styles.actionText, { color: theme.colors.foreground }]}>{action.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={controller.handleLeave} style={[styles.action, styles.dangerAction, { backgroundColor: theme.colors.card, borderColor: theme.colors.error }]}>
            <Text style={[styles.actionText, styles.dangerText, { color: theme.colors.error }]}>Leave space</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

export function SpacePanel({ controller }: { readonly controller: Controller }): React.JSX.Element {
  const theme = useNativeTheme();
  return (
    <Modal animationType="slide" onRequestClose={controller.closePanel} presentationStyle="pageSheet" visible={controller.panel !== null}>
      <View style={[styles.panel, { backgroundColor: theme.colors.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
          <Text style={[styles.title, { color: theme.colors.foreground }]}>{controller.panel === "chat" ? "Chat" : controller.panel === "participants" ? "Participants" : "Settings"}</Text>
          <Pressable onPress={controller.closePanel} style={styles.close}>
            <Text style={[styles.closeText, { color: theme.colors.primary }]}>Done</Text>
          </Pressable>
        </View>
        {controller.panel === "chat" ? <ChatPanel controller={controller} /> : controller.panel === "participants" ? <ParticipantsPanel controller={controller} /> : <SettingsPanel controller={controller} />}
      </View>
    </Modal>
  );
}

function SettingsPanel({ controller }: { readonly controller: Controller }): React.JSX.Element {
  const theme = useNativeTheme();
  const [displayName, setDisplayName] = useState(controller.settings.displayName);
  useEffect(() => setDisplayName(controller.settings.displayName), [controller.settings.displayName]);
  const canSaveDisplayName = displayName.trim().length > 0 && displayName.trim() !== controller.settings.displayName;

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Text style={[styles.sectionTitle, { color: theme.colors.mutedForeground }]}>Profile</Text>
      <TextInput onChangeText={setDisplayName} placeholder="Display name" placeholderTextColor={theme.colors.placeholder} style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.foreground }]} value={displayName} />
      <Pressable disabled={!canSaveDisplayName} onPress={() => controller.settings.updateDisplayName(displayName)} style={[styles.send, { backgroundColor: theme.colors.primary }, !canSaveDisplayName && styles.disabled]}>
        <Text style={[styles.sendText, { color: theme.colors.primaryForeground }]}>Save display name</Text>
      </Pressable>
      <Text style={[styles.sectionTitle, { color: theme.colors.mutedForeground }]}>Media</Text>
      <Pressable onPress={controller.toggleAudio} style={[styles.action, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.actionText, { color: theme.colors.foreground }]}>{controller.settings.microphoneEnabled ? "Mute microphone" : "Enable microphone"}</Text>
      </Pressable>
      <Pressable onPress={controller.toggleVideo} style={[styles.action, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.actionText, { color: theme.colors.foreground }]}>{controller.settings.cameraEnabled ? "Turn camera off" : "Turn camera on"}</Text>
      </Pressable>
      <DeviceSettings label="Microphone" devices={controller.settings.devices.microphones} onSelect={controller.settings.selectMicrophone} selected={controller.settings.selection.microphone} />
      <DeviceSettings label="Camera" devices={controller.settings.devices.cameras} onSelect={controller.settings.selectCamera} selected={controller.settings.selection.camera} />
      <DeviceSettings label="Speaker" devices={controller.settings.devices.speakers} onSelect={controller.settings.selectSpeaker} selected={controller.settings.selection.speaker} />
    </ScrollView>
  );
}

function DeviceSettings({ label, devices, selected, onSelect }: { readonly label: string; readonly devices: readonly { readonly deviceId: string; readonly label: string }[]; readonly selected: string | null; readonly onSelect: (deviceId: string) => void }): React.JSX.Element | null {
  const theme = useNativeTheme();
  if (!devices.length) return null;
  return (
    <View style={styles.deviceSection}>
      <Text style={[styles.sectionTitle, { color: theme.colors.mutedForeground }]}>{label}</Text>
      {devices.map((device) => (
        <Pressable key={device.deviceId} onPress={() => onSelect(device.deviceId)} style={[styles.action, { backgroundColor: theme.colors.card }, selected === device.deviceId && [styles.selectedAction, { borderColor: theme.colors.primary }]]}>
          <Text style={[styles.actionText, { color: theme.colors.foreground }]}>{device.label || label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ChatPanel({ controller }: { readonly controller: Controller }): React.JSX.Element {
  const theme = useNativeTheme();
  return (
    <View style={styles.flex}>
      {controller.chat.hasMore ? (
        <Pressable disabled={controller.chat.isLoadingOlder} onPress={() => void controller.chat.loadOlderMessages()} style={styles.loadOlder}>
          <Text style={[styles.secondaryText, { color: theme.colors.mutedForeground }]}>{controller.chat.isLoadingOlder ? "Loading…" : "Load earlier messages"}</Text>
        </Pressable>
      ) : null}
      <FlatList
        contentContainerStyle={styles.list}
        data={controller.chat.messages}
        keyExtractor={(message) => message.id}
        onViewableItemsChanged={({ viewableItems }) => {
          const sequence = viewableItems.at(-1)?.item.sequence;
          if (sequence) controller.markChatMessageVisible(sequence);
        }}
        renderItem={({ item }) => (
          <View style={[styles.message, { backgroundColor: theme.colors.card }]}>
            <Text style={[styles.itemTitle, { color: theme.colors.foreground }]}>{item.senderName}</Text>
            <Text style={[styles.body, { color: theme.colors.foreground }]}>{item.text}</Text>
            {item.attachments.map((attachment) => (
              <Pressable accessibilityRole="link" key={attachment.attachmentId} onPress={() => controller.openChatAttachment(attachment.attachmentId)}>
                <Text style={[styles.attachment, { color: theme.colors.primary }]}>{attachment.fileName}</Text>
              </Pressable>
            ))}
            {item.readBy.length ? <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>Read by {item.readBy.map((reader) => reader.displayName).join(", ")}</Text> : null}
          </View>
        )}
      />
      {controller.chat.pendingMessages.map((message) => (
        <View key={message.clientMessageId} style={[styles.pending, { borderColor: theme.colors.border }]}>
          <Text style={[styles.body, { color: theme.colors.foreground }]}>{message.text}</Text>
          <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>{message.state === "sending" ? "Sending…" : (message.error?.message ?? "Send failed")}</Text>
          {message.state === "failed" ? (
            <Pressable onPress={() => void controller.chat.retryMessage(message.clientMessageId)}>
              <Text style={[styles.link, { color: theme.colors.primary }]}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      <View style={[styles.composer, { borderTopColor: theme.colors.border }]}>
        <TextInput
          multiline
          onChangeText={controller.setChatDraft}
          onSubmitEditing={controller.sendChatMessage}
          placeholder="Message everyone"
          placeholderTextColor={theme.colors.placeholder}
          style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.foreground }]}
          value={controller.chatDraft}
        />
        <Pressable disabled={!controller.chatDraft.trim()} onPress={controller.sendChatMessage} style={[styles.send, { backgroundColor: theme.colors.primary }]}>
          <Text style={[styles.sendText, { color: theme.colors.primaryForeground }]}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ParticipantsPanel({ controller }: { readonly controller: Controller }): React.JSX.Element {
  const theme = useNativeTheme();
  return (
    <ScrollView contentContainerStyle={styles.list}>
      {controller.admissionRequests.map((request) => (
        <View key={request.requestId} style={[styles.request, { borderColor: theme.colors.primary }]}>
          <View style={styles.flex}>
            <Text style={[styles.itemTitle, { color: theme.colors.foreground }]}>{request.displayName}</Text>
            <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>Waiting to join</Text>
          </View>
          {controller.canManageAdmission ? (
            <>
              <Pressable onPress={() => controller.admitParticipant(request.requestId)}>
                <Text style={[styles.link, { color: theme.colors.primary }]}>Admit</Text>
              </Pressable>
              <Pressable onPress={() => controller.denyAdmission(request.requestId)}>
                <Text style={[styles.dangerText, { color: theme.colors.error }]}>Deny</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ))}
      {controller.participants.participants.map((participant) => {
        const local = participant.id === controller.participants.localParticipant?.id;
        return (
          <View key={participant.id} style={[styles.participant, { borderBottomColor: theme.colors.border }]}>
            <View style={styles.flex}>
              <Text style={[styles.itemTitle, { color: theme.colors.foreground }]}>
                {participant.displayName}
                {local ? " (you)" : ""}
              </Text>
              <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>
                {participant.role} · {participant.audioEnabled ? "mic on" : "muted"} · {participant.videoEnabled ? "camera on" : "camera off"}
              </Text>
            </View>
            {!local && canActOnParticipant(controller) ? (
              <Pressable onPress={() => openParticipantActions(controller, participant.id, participant.role)}>
                <Text style={[styles.link, { color: theme.colors.primary }]}>Manage</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function canActOnParticipant(controller: Controller): boolean {
  return controller.canMuteParticipants || controller.canRequestMedia || controller.canStopParticipantCamera || controller.canStopParticipantScreenShare || controller.canSetParticipantRole || controller.canRemoveParticipants;
}

function openParticipantActions(controller: Controller, participantId: string, role: string): void {
  const buttons: { readonly label: string; readonly action: () => void }[] = [];
  if (controller.canMuteParticipants) buttons.push({ label: "Mute", action: () => controller.muteParticipant(participantId) });
  if (controller.canRequestMedia) {
    buttons.push({ label: "Request unmute", action: () => controller.requestUnmuteParticipant(participantId) }, { label: "Request camera", action: () => controller.requestStartParticipantCamera(participantId) });
  }
  if (controller.canStopParticipantCamera) buttons.push({ label: "Stop camera", action: () => controller.stopParticipantCamera(participantId) });
  if (controller.canStopParticipantScreenShare) buttons.push({ label: "Stop presenting", action: () => controller.stopParticipantScreenShare(participantId) });
  if (controller.canSetParticipantRole) {
    const nextRole = role === "collaborator" ? "observer" : "collaborator";
    buttons.push({ label: nextRole === "collaborator" ? "Set collaborator role" : "Set observer role", action: () => controller.setParticipantRole(participantId, nextRole) });
  }
  if (controller.canRemoveParticipants) buttons.push({ label: "Remove", action: () => controller.removeParticipant(participantId) });
  // A compact nested modal keeps platform behavior predictable without inventing a second role vocabulary.
  controller.closePanel();
  globalThis.setTimeout(() => {
    Alert.alert("Manage participant", undefined, [...buttons.map((button) => ({ text: button.label, onPress: button.action })), { text: "Cancel", style: "cancel" }]);
  }, 120);
}

export function selectSpaceReaction(controller: Controller, reaction: string): void {
  controller.sendReaction(reaction as Reaction);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: Theme.colors.darkOverlay55 },
  sheet: {
    gap: 8,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: Theme.colors.background,
    padding: 24,
    paddingBottom: 40,
  },
  panel: { flex: 1, backgroundColor: Theme.colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: Theme.colors.border,
    padding: 20,
  },
  title: { ...Theme.typography.title, color: Theme.colors.foreground },
  close: { padding: 8 },
  closeText: { color: Theme.colors.primary, fontWeight: "700" },
  action: { borderRadius: 14, backgroundColor: Theme.colors.card, padding: 16 },
  actionText: { color: Theme.colors.foreground, fontSize: 16, fontWeight: "600" },
  dangerAction: { marginTop: 8, borderWidth: 1, borderColor: Theme.colors.error },
  dangerText: { color: Theme.colors.error, fontWeight: "700" },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.65 },
  list: { padding: 16, gap: 12 },
  loadOlder: { alignItems: "center", padding: 12 },
  secondaryText: { color: Theme.colors.mutedForeground },
  message: { gap: 4, borderRadius: 14, backgroundColor: Theme.colors.card, padding: 12 },
  pending: { marginHorizontal: 16, marginBottom: 8, gap: 4, borderRadius: 14, borderWidth: 1, borderColor: Theme.colors.border, padding: 12 },
  itemTitle: { color: Theme.colors.foreground, fontWeight: "700" },
  body: { color: Theme.colors.foreground, fontSize: 15 },
  meta: { color: Theme.colors.mutedForeground, fontSize: 12 },
  attachment: { color: Theme.colors.primary, fontSize: 13 },
  link: { color: Theme.colors.primary, fontWeight: "700" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, borderTopWidth: 1, borderTopColor: Theme.colors.border, padding: 12 },
  input: { flex: 1, maxHeight: 120, borderRadius: 16, backgroundColor: Theme.colors.card, color: Theme.colors.foreground, paddingHorizontal: 14, paddingVertical: 10 },
  send: { borderRadius: 14, backgroundColor: Theme.colors.primary, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: Theme.colors.primaryForeground, fontWeight: "800" },
  participant: { flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderBottomColor: Theme.colors.border, paddingVertical: 12 },
  request: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 14, borderWidth: 1, borderColor: Theme.colors.primary, padding: 12 },
  sectionTitle: { color: Theme.colors.mutedForeground, fontSize: 13, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.8, marginTop: 8 },
  deviceSection: { gap: 8 },
  selectedAction: { borderWidth: 1, borderColor: Theme.colors.primary },
});
