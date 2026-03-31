import { getParticipantAvatarRecipe, type ChatMessage, type LayoutMode, type MediaDevice, type ParticipantState, type Transcript } from "@q9labs/chalk-core";
import { ArrowUp01Icon, Cancel01Icon, Chat01Icon, CheckmarkCircle01Icon, Mic01Icon, MicOff01Icon, Presentation01Icon, Refresh01Icon, Settings01Icon, TextFontIcon, UserGroupIcon, Video01Icon, VideoOffIcon, WavingHand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, Modal, TouchableWithoutFeedback, Platform } from "react-native";
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
  return (
    <Modal animationType="slide" transparent={true} visible={!!panel} onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <View style={styles.dragHandle} />

              <View style={styles.sheetHeader}>
                <View style={styles.titleRow}>
                  <HugeiconsIcon icon={panelIcon(panel)} size={20} color={Theme.colors.primary} />
                  <Text style={styles.sheetTitle}>
                    {panelTitle(panel)}
                    {panel === "participants" && <Text style={styles.headerCount}> ({participants.length})</Text>}
                  </Text>
                </View>
                <Pressable onPress={onClose} style={styles.closeButton}>
                  <HugeiconsIcon icon={Cancel01Icon} size={20} color={Theme.colors.mutedForeground} />
                </Pressable>
              </View>

              {panel === "chat" ? (
                <View style={styles.chatWrapper}>
                  <ScrollView style={styles.chatScroll} contentContainerStyle={styles.chatScrollContent} showsVerticalScrollIndicator={false}>
                    {messages.length === 0 ? (
                      <View style={styles.emptyState}>
                        <HugeiconsIcon icon={Chat01Icon} size={40} color={Theme.colors.mutedForeground} />
                        <Text style={styles.emptyText}>No messages yet.</Text>
                      </View>
                    ) : null}
                    {messages.map((message, index) => {
                      const isLocal = message.senderId === localParticipantId;
                      return (
                        <View key={`${message.id ?? "msg"}-${index}`} style={styles.messageGroup}>
                          {!isLocal && <Text style={styles.bubbleSender}>{message.senderName}</Text>}
                          <View style={isLocal ? styles.localBubble : styles.remoteBubble}>
                            <Text style={styles.bubbleText}>{message.content}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </ScrollView>
                  <View style={styles.composerRow}>
                    <TextInput onChangeText={onChatDraftChange} onSubmitEditing={onSendMessage} placeholder="Type a message..." placeholderTextColor={Theme.colors.placeholder} style={styles.input} value={chatDraft} />
                    <Pressable onPress={onSendMessage} style={styles.sendButton}>
                      <HugeiconsIcon icon={ArrowUp01Icon} size={20} color="white" />
                    </Pressable>
                  </View>
                </View>
              ) : (
                <ScrollView contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
                  {panel === "participants" && (
                    <View style={styles.listContainer}>
                      {participants.map((participant, index) => {
                        const isLocal = participant.id === localParticipantId;
                        return (
                          <View key={`${participant.id}-${index}`} style={styles.participantRow}>
                            <View style={styles.participantInfo}>
                              <View style={[styles.avatarCircle, { backgroundColor: getParticipantAvatarRecipe(participant.displayName).colors.primary }]}>
                                <Text style={styles.avatarText}>{(participant.displayName?.charAt(0) || "P").toUpperCase()}</Text>
                              </View>
                              <View style={styles.participantMeta}>
                                <View style={styles.participantNameRow}>
                                  <Text style={styles.participantName}>
                                    {participant.displayName}
                                    {isLocal ? " (You)" : ""}
                                  </Text>
                                  {participant.role === "host" && (
                                    <View style={styles.roleChip}>
                                      <Text style={styles.roleChipText}>Host</Text>
                                    </View>
                                  )}
                                </View>
                                <View style={styles.participantStatusIcons}>
                                  <HugeiconsIcon icon={participant.audioEnabled ? Mic01Icon : MicOff01Icon} size={14} color={participant.audioEnabled ? Theme.colors.success : Theme.colors.error} />
                                  <HugeiconsIcon icon={participant.videoEnabled ? Video01Icon : VideoOffIcon} size={14} color={participant.videoEnabled ? Theme.colors.success : "rgba(255,255,255,0.3)"} />
                                  {participant.handRaised && <HugeiconsIcon icon={WavingHand01Icon} size={14} color={Theme.colors.warning} />}
                                </View>
                              </View>
                            </View>
                            {isHost && !isLocal ? (
                              <View style={styles.actionButtons}>
                                <Pressable onPress={() => (participant.audioEnabled ? onMuteParticipant(participant.id) : onUnmuteParticipant(participant.id))} style={styles.iconActionBtn}>
                                  <HugeiconsIcon icon={participant.audioEnabled ? MicOff01Icon : Mic01Icon} size={16} color={participant.audioEnabled ? Theme.colors.error : Theme.colors.success} />
                                </Pressable>
                                <Pressable onPress={() => onRemoveParticipant(participant.id)} style={[styles.iconActionBtn, styles.dangerActionBtn]}>
                                  <HugeiconsIcon icon={Cancel01Icon} size={16} color={Theme.colors.error} />
                                </Pressable>
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  )}

                  {panel === "settings" && (
                    <View style={styles.settingsContainer}>
                      <Text style={styles.sectionLabel}>Layout</Text>
                      <View style={styles.rowWrap}>
                        {(["auto", "grid", "spotlight", "speaker"] as const).map((option) => (
                          <Pressable key={option} onPress={() => onSetLayout(option)} style={[styles.chip, layout === option && styles.chipActive]}>
                            <Text style={[styles.chipText, layout === option && styles.chipTextActive]}>{layoutOptionLabel(option)}</Text>
                          </Pressable>
                        ))}
                      </View>

                      <Text style={styles.sectionLabel}>Camera</Text>
                      <DeviceList devices={cameras} selectedId={selectedCamera} onSelect={onSelectCamera} />

                      <Text style={styles.sectionLabel}>Microphone</Text>
                      <DeviceList devices={microphones} selectedId={selectedMicrophone} onSelect={onSelectMicrophone} />

                      <Text style={styles.sectionLabel}>Speaker</Text>
                      <DeviceList devices={speakers} selectedId={selectedSpeaker} onSelect={onSelectSpeaker} />

                      <Pressable onPress={onRefreshDevices} style={styles.refreshButton}>
                        <HugeiconsIcon icon={Refresh01Icon} size={16} color={Theme.colors.primary} />
                        <Text style={styles.refreshButtonText}>{isRefreshingDevices ? "Refreshing..." : "Refresh Devices"}</Text>
                      </Pressable>
                    </View>
                  )}

                  {panel === "transcripts" && (
                    <View style={styles.transcriptsContainer}>
                      {transcripts.length === 0 ? (
                        <View style={styles.emptyState}>
                          <HugeiconsIcon icon={Mic01Icon} size={40} color={Theme.colors.mutedForeground} />
                          <Text style={styles.emptyText}>Transcription will appear here</Text>
                          <Text style={styles.emptySubtext}>Audio will be transcribed in real-time</Text>
                        </View>
                      ) : null}
                      {transcripts.map((transcript, index) => (
                        <View key={`${transcript.id ?? "t"}-${index}`} style={styles.transcriptEntry}>
                          <Text style={styles.transcriptSpeaker}>{transcript.speakerName}</Text>
                          <View style={styles.transcriptDivider} />
                          <Text style={styles.transcriptText}>{transcript.text}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {panel === "whiteboard" && (
                    <View style={styles.whiteboardContainer}>
                      <View style={styles.statusCard}>
                        <View style={styles.statusHeader}>
                          <HugeiconsIcon icon={Presentation01Icon} size={24} color={Theme.colors.primary} />
                          <Text style={styles.statusTitle}>Whiteboard</Text>
                        </View>
                        <Text style={styles.metaText}>Mode: {whiteboardCanDraw ? "Collaborative" : "View Only"}</Text>
                        <Text style={styles.metaText}>
                          Elements: {whiteboardElementCount} · Active: {whiteboardParticipantCount}
                        </Text>
                      </View>
                      <View style={styles.buttonGrid}>
                        <Pressable onPress={onToggleWhiteboard} style={styles.primaryPanelButton}>
                          <Text style={styles.primaryButtonText}>{whiteboardOpen ? "Close Board" : "Open Board"}</Text>
                        </Pressable>
                        <View style={styles.row}>
                          <Pressable onPress={onRequestWhiteboardSync} style={styles.secondaryPanelButton}>
                            <Text style={styles.secondaryButtonText}>Sync</Text>
                          </Pressable>
                          <Pressable onPress={onClearWhiteboard} style={styles.secondaryPanelButton}>
                            <Text style={styles.secondaryButtonText}>Clear</Text>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  )}
                </ScrollView>
              )}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function DeviceList({ devices, selectedId, onSelect }: { devices: readonly MediaDevice[]; selectedId: string | null; onSelect: (deviceId: string) => void }): React.JSX.Element {
  if (devices.length === 0) {
    return <Text style={styles.emptyText}>No devices detected.</Text>;
  }

  return (
    <View style={styles.deviceList}>
      {devices.map((device, index) => {
        const isSelected = selectedId === device.deviceId;
        return (
          <Pressable key={`${device.deviceId || "device"}-${device.label || "unknown"}-${index}`} onPress={() => onSelect(device.deviceId)} style={[styles.deviceItem, isSelected && styles.deviceItemSelected]}>
            <Text style={[styles.deviceItemText, isSelected && styles.deviceItemTextSelected]} numberOfLines={1}>
              {device.label || "Default Device"}
            </Text>
            {isSelected && <HugeiconsIcon icon={CheckmarkCircle01Icon} size={16} color={Theme.colors.primary} />}
          </Pressable>
        );
      })}
    </View>
  );
}

function panelTitle(panel: NativeMeetingPanelName | null): string {
  switch (panel) {
    case "chat":
      return "Chat";
    case "participants":
      return "Participants";
    case "settings":
      return "Device Settings";
    case "transcripts":
      return "Transcripts";
    case "whiteboard":
      return "Whiteboard";
    default:
      return "";
  }
}

function panelIcon(panel: NativeMeetingPanelName | null): any {
  switch (panel) {
    case "chat":
      return Chat01Icon;
    case "participants":
      return UserGroupIcon;
    case "settings":
      return Settings01Icon;
    case "transcripts":
      return TextFontIcon;
    case "whiteboard":
      return Presentation01Icon;
    default:
      return Settings01Icon;
  }
}

function layoutOptionLabel(layout: LayoutMode): string {
  switch (layout) {
    case "auto":
      return "Auto";
    case "grid":
      return "Grid";
    case "spotlight":
      return "Focus";
    case "speaker":
      return "Speaker Rail";
    default:
      return layout;
  }
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#0c0c0e",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    height: "70%",
    maxHeight: "85%",
    paddingBottom: Platform.OS === "ios" ? 40 : 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(255,255,255,0.08)",
  },
  dragHandle: {
    width: 40,
    height: 4,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 12,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.05)",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Theme.colors.foreground,
  },
  headerCount: {
    color: Theme.colors.mutedForeground,
    fontWeight: "600",
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
  sheetContent: {
    padding: 20,
  },

  // Chat
  chatWrapper: {
    flex: 1,
  },
  chatScroll: {
    flex: 1,
  },
  chatScrollContent: {
    padding: 16,
    gap: 6,
  },
  messageGroup: {
    marginBottom: 8,
  },
  bubbleSender: {
    fontSize: 11,
    fontWeight: "700",
    color: Theme.colors.primary,
    marginBottom: 2,
    marginLeft: 4,
  },
  remoteBubble: {
    alignSelf: "flex-start",
    backgroundColor: Theme.colors.secondary,
    borderRadius: 16,
    borderTopLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "78%",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.04)",
  },
  localBubble: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(27, 182, 166, 0.22)",
    borderRadius: 16,
    borderTopRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "78%",
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.12)",
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 20,
    color: Theme.colors.foreground,
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.05)",
  },
  input: {
    flex: 1,
    backgroundColor: Theme.colors.secondary,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: Theme.colors.foreground,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },

  // Settings
  settingsContainer: {
    gap: 20,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: Theme.colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  rowWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Theme.radius.full,
    backgroundColor: Theme.colors.secondary,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  chipActive: {
    backgroundColor: "rgba(27, 182, 166, 0.15)",
    borderColor: Theme.colors.primary,
  },
  chipText: {
    fontSize: 14,
    fontWeight: "600",
    color: Theme.colors.mutedForeground,
  },
  chipTextActive: {
    color: Theme.colors.primary,
  },
  deviceList: {
    gap: 8,
  },
  deviceItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    borderRadius: 14,
    backgroundColor: Theme.colors.secondary,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  deviceItemSelected: {
    borderColor: Theme.colors.primary,
    backgroundColor: "rgba(27, 182, 166, 0.05)",
  },
  deviceItemText: {
    fontSize: 14,
    color: Theme.colors.foreground,
    flex: 1,
    marginRight: 10,
  },
  deviceItemTextSelected: {
    fontWeight: "600",
  },
  refreshButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
    padding: 12,
  },
  refreshButtonText: {
    color: Theme.colors.primary,
    fontSize: 14,
    fontWeight: "600",
  },

  // Participants
  listContainer: {
    gap: 8,
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: Theme.colors.secondary,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.04)",
  },
  participantInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  avatarCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: Theme.colors.foreground,
    fontWeight: "700",
  },
  participantMeta: {
    gap: 4,
    flexShrink: 1,
  },
  participantNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  participantName: {
    fontSize: 15,
    fontWeight: "600",
    color: Theme.colors.foreground,
  },
  roleChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "rgba(27, 182, 166, 0.15)",
  },
  roleChipText: {
    fontSize: 10,
    fontWeight: "700",
    color: Theme.colors.primary,
    textTransform: "uppercase",
  },
  participantStatusIcons: {
    flexDirection: "row",
    gap: 8,
    marginTop: 2,
  },
  actionButtons: {
    flexDirection: "row",
    gap: 8,
  },
  iconActionBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
  dangerActionBtn: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
  },

  // Transcripts
  transcriptsContainer: {
    gap: 4,
  },
  transcriptEntry: {
    marginBottom: 20,
    gap: 6,
  },
  transcriptSpeaker: {
    fontSize: 13,
    fontWeight: "700",
    color: Theme.colors.primary,
  },
  transcriptDivider: {
    height: 1,
    width: 40,
    backgroundColor: "rgba(27, 182, 166, 0.3)",
  },
  transcriptText: {
    fontSize: 15,
    lineHeight: 22,
    color: Theme.colors.foreground,
  },

  // Empty state
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    color: Theme.colors.mutedForeground,
    fontSize: 14,
  },
  emptySubtext: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    opacity: 0.7,
  },

  // Whiteboard
  whiteboardContainer: {
    gap: 20,
  },
  statusCard: {
    backgroundColor: Theme.colors.secondary,
    padding: 20,
    borderRadius: 16,
    gap: 8,
  },
  statusHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 4,
  },
  statusTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Theme.colors.foreground,
  },
  metaText: {
    fontSize: 13,
    color: Theme.colors.mutedForeground,
  },
  buttonGrid: {
    gap: 12,
  },
  primaryPanelButton: {
    backgroundColor: Theme.colors.primary,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "700",
  },
  secondaryPanelButton: {
    flex: 1,
    backgroundColor: Theme.colors.secondary,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  secondaryButtonText: {
    color: Theme.colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    gap: 12,
  },
});
