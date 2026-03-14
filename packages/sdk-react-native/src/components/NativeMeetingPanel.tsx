import type { ChatMessage, LayoutMode, MediaDevice, ParticipantState, Transcript } from "@q9labs/chalk-core";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Theme } from "../ui/theme";

export type NativeMeetingPanelName = "chat" | "participants" | "settings" | "transcripts" | "whiteboard";
type RoomParticipant = ParticipantState["participants"][number];

interface NativeMeetingPanelProps {
  panel: NativeMeetingPanelName | null;
  participants: readonly RoomParticipant[];
  localParticipantId: string | null;
  isHost: boolean;
  messages: readonly ChatMessage[];
  transcripts: readonly Transcript[];
  chatDraft: string;
  layout: LayoutMode;
  cameras: readonly MediaDevice[];
  microphones: readonly MediaDevice[];
  speakers: readonly MediaDevice[];
  selectedCamera: string | null;
  selectedMicrophone: string | null;
  selectedSpeaker: string | null;
  isRefreshingDevices: boolean;
  whiteboardOpen: boolean;
  whiteboardCanDraw: boolean;
  whiteboardElementCount: number;
  whiteboardParticipantCount: number;
  onChatDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onClose: () => void;
  onSetLayout: (layout: LayoutMode) => void;
  onSelectCamera: (deviceId: string) => void;
  onSelectMicrophone: (deviceId: string) => void;
  onSelectSpeaker: (deviceId: string) => void;
  onRefreshDevices: () => void;
  onToggleWhiteboard: () => void;
  onRequestWhiteboardSync: () => void;
  onClearWhiteboard: () => void;
  onMuteParticipant: (participantId: string) => void;
  onUnmuteParticipant: (participantId: string) => void;
  onRemoveParticipant: (participantId: string) => void;
}

export function NativeMeetingPanel({
  panel,
  participants,
  localParticipantId,
  isHost,
  messages,
  transcripts,
  chatDraft,
  layout,
  cameras,
  microphones,
  speakers,
  selectedCamera,
  selectedMicrophone,
  selectedSpeaker,
  isRefreshingDevices,
  whiteboardOpen,
  whiteboardCanDraw,
  whiteboardElementCount,
  whiteboardParticipantCount,
  onChatDraftChange,
  onSendMessage,
  onClose,
  onSetLayout,
  onSelectCamera,
  onSelectMicrophone,
  onSelectSpeaker,
  onRefreshDevices,
  onToggleWhiteboard,
  onRequestWhiteboardSync,
  onClearWhiteboard,
  onMuteParticipant,
  onUnmuteParticipant,
  onRemoveParticipant,
}: NativeMeetingPanelProps): React.JSX.Element | null {
  if (!panel) {
    return null;
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>{panelTitle(panel)}</Text>
        <Pressable onPress={onClose} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>Close</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.sheetContent}>
        {panel === "chat" ? (
          <>
            {messages.length === 0 ? <Text style={styles.emptyText}>No messages yet.</Text> : null}
            {messages.map((message) => (
              <View key={message.id} style={styles.messageCard}>
                <Text style={styles.messageAuthor}>{message.senderName}</Text>
                <Text style={styles.messageBody}>{message.content}</Text>
              </View>
            ))}
            <View style={styles.composerRow}>
              <TextInput
                onChangeText={onChatDraftChange}
                onSubmitEditing={onSendMessage}
                placeholder="Send a message"
                placeholderTextColor={Theme.colors.placeholder}
                style={styles.input}
                value={chatDraft}
              />
              <Pressable onPress={onSendMessage} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Send</Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {panel === "participants" ? (
          <>
            {participants.map((participant) => {
              const isLocal = participant.id === localParticipantId;
              const audioOn = participant.audioEnabled;
              const videoOn = participant.videoEnabled;

              return (
                <View key={participant.id} style={styles.listCard}>
                  <View style={styles.participantMeta}>
                    <Text style={styles.messageAuthor}>
                      {participant.displayName}
                      {isLocal ? " (You)" : ""}
                    </Text>
                    <Text style={styles.metaText}>
                      {participant.role} · {audioOn ? "mic on" : "mic off"} · {videoOn ? "cam on" : "cam off"}
                      {participant.handRaised ? " · hand raised" : ""}
                      {participant.isScreenSharing ? " · presenting" : ""}
                    </Text>
                  </View>
                  {isHost && !isLocal ? (
                    <View style={styles.row}>
                      <Pressable onPress={() => (audioOn ? onMuteParticipant(participant.id) : onUnmuteParticipant(participant.id))} style={styles.secondaryButton}>
                        <Text style={styles.secondaryButtonText}>{audioOn ? "Mute" : "Unmute"}</Text>
                      </Pressable>
                      <Pressable onPress={() => onRemoveParticipant(participant.id)} style={styles.dangerButton}>
                        <Text style={styles.primaryButtonText}>Remove</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </>
        ) : null}

        {panel === "transcripts" ? (
          <>
            {transcripts.length === 0 ? <Text style={styles.emptyText}>No transcript lines yet.</Text> : null}
            {transcripts.map((transcript) => (
              <View key={transcript.id} style={styles.messageCard}>
                <Text style={styles.messageAuthor}>{transcript.speakerName}</Text>
                <Text style={styles.messageBody}>{transcript.text}</Text>
              </View>
            ))}
          </>
        ) : null}

        {panel === "settings" ? (
          <>
            <Text style={styles.sectionLabel}>Layout</Text>
            <View style={styles.rowWrap}>
              {(["auto", "grid", "spotlight", "speaker"] as const).map((option) => (
                <Pressable key={option} onPress={() => onSetLayout(option)} style={[styles.chip, layout === option && styles.chipActive]}>
                  <Text style={[styles.chipText, layout === option && styles.chipTextActive]}>{option}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sectionLabel}>Camera</Text>
            <DeviceList devices={cameras} selectedId={selectedCamera} onSelect={onSelectCamera} />

            <Text style={styles.sectionLabel}>Microphone</Text>
            <DeviceList devices={microphones} selectedId={selectedMicrophone} onSelect={onSelectMicrophone} />

            <Text style={styles.sectionLabel}>Speaker</Text>
            <DeviceList devices={speakers} selectedId={selectedSpeaker} onSelect={onSelectSpeaker} />

            <Pressable onPress={onRefreshDevices} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{isRefreshingDevices ? "Refreshing..." : "Refresh devices"}</Text>
            </Pressable>
          </>
        ) : null}

        {panel === "whiteboard" ? (
          <>
            <View style={styles.listCard}>
              <Text style={styles.messageAuthor}>{whiteboardOpen ? "Whiteboard open" : "Whiteboard closed"}</Text>
              <Text style={styles.metaText}>
                Draw: {whiteboardCanDraw ? "allowed" : "read only"} · Elements: {whiteboardElementCount} · Open peers: {whiteboardParticipantCount}
              </Text>
            </View>
            <View style={styles.row}>
              <Pressable onPress={onToggleWhiteboard} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>{whiteboardOpen ? "Close" : "Open"}</Text>
              </Pressable>
              <Pressable onPress={onRequestWhiteboardSync} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Sync</Text>
              </Pressable>
              <Pressable onPress={onClearWhiteboard} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Clear</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function DeviceList({
  devices,
  selectedId,
  onSelect,
}: {
  devices: readonly MediaDevice[];
  selectedId: string | null;
  onSelect: (deviceId: string) => void;
}): React.JSX.Element {
  if (devices.length === 0) {
    return <Text style={styles.emptyText}>No devices reported.</Text>;
  }

  return (
    <View style={styles.rowWrap}>
      {devices.map((device) => (
        <Pressable key={device.deviceId} onPress={() => onSelect(device.deviceId)} style={[styles.chip, selectedId === device.deviceId && styles.chipActive]}>
          <Text style={[styles.chipText, selectedId === device.deviceId && styles.chipTextActive]}>{device.label || device.deviceId}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function panelTitle(panel: NativeMeetingPanelName): string {
  switch (panel) {
    case "chat":
      return "Chat";
    case "participants":
      return "Participants";
    case "settings":
      return "Settings";
    case "transcripts":
      return "Transcripts";
    case "whiteboard":
      return "Whiteboard";
  }
}

const styles = StyleSheet.create({
  sheet: {
    borderTopWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.card,
    maxHeight: 420,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.md,
  },
  sheetTitle: {
    ...Theme.typography.subheading,
    color: Theme.colors.foreground,
  },
  closeButton: {
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
  },
  closeButtonText: {
    ...Theme.typography.label,
    color: Theme.colors.primary,
  },
  sheetContent: {
    paddingHorizontal: Theme.spacing.lg,
    paddingBottom: Theme.spacing["2xl"],
    gap: Theme.spacing.md,
  },
  row: {
    flexDirection: "row",
    gap: Theme.spacing.sm,
  },
  rowWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Theme.spacing.sm,
  },
  listCard: {
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.secondary,
    padding: Theme.spacing.md,
    gap: Theme.spacing.sm,
  },
  participantMeta: {
    gap: Theme.spacing.xs,
  },
  messageCard: {
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.secondary,
    padding: Theme.spacing.md,
    gap: Theme.spacing.xs,
  },
  messageAuthor: {
    ...Theme.typography.label,
    color: Theme.colors.foreground,
  },
  messageBody: {
    ...Theme.typography.body,
    color: Theme.colors.foreground,
  },
  metaText: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.secondary,
    color: Theme.colors.foreground,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.md,
  },
  sectionLabel: {
    ...Theme.typography.label,
    color: Theme.colors.foreground,
    marginTop: Theme.spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius.full,
    backgroundColor: Theme.colors.secondary,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
  },
  chipActive: {
    backgroundColor: Theme.colors.primary,
    borderColor: Theme.colors.primary,
  },
  chipText: {
    ...Theme.typography.meta,
    color: Theme.colors.foreground,
  },
  chipTextActive: {
    color: Theme.colors.primaryForeground,
  },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.primary,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.md,
  },
  primaryButtonText: {
    color: Theme.colors.primaryForeground,
    fontSize: 14,
    fontWeight: "800",
  },
  secondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.lg,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.secondary,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.md,
  },
  secondaryButtonText: {
    color: Theme.colors.foreground,
    fontSize: 14,
    fontWeight: "700",
  },
  dangerButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.error,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.md,
  },
  emptyText: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
  },
});
