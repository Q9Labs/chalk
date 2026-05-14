import { getParticipantAvatarRecipe, type ChatMessage, type MediaDevice, type Transcript } from "@q9labs/chalk-core";
import ArrowUp01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowUp01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/dist/esm/Cancel01Icon";
import Chat01Icon from "@hugeicons/core-free-icons/dist/esm/Chat01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Presentation01Icon from "@hugeicons/core-free-icons/dist/esm/Presentation01Icon";
import Refresh01Icon from "@hugeicons/core-free-icons/dist/esm/Refresh01Icon";
import Settings01Icon from "@hugeicons/core-free-icons/dist/esm/Settings01Icon";
import TextFontIcon from "@hugeicons/core-free-icons/dist/esm/TextFontIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import WavingHand01Icon from "@hugeicons/core-free-icons/dist/esm/WavingHand01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableWithoutFeedback, View } from "react-native";
import { phoneMeetingPanelContentFrame, phoneMeetingPanelSheetFrame } from "./native-meeting-room/phone-panel-layout";
import { Theme } from "../ui/theme";
import type { NativeMeetingPanelName, RoomParticipant } from "./native-meeting-room/types";

export interface NativeMeetingPanelProps {
  panel: NativeMeetingPanelName | null;
  participants: readonly RoomParticipant[];
  localParticipantId: string | null;
  isHost: boolean;
  messages: readonly ChatMessage[];
  transcripts: readonly Transcript[];
  chatDraft: string;
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

export function NativeMeetingPanelIosPhone({
  panel,
  participants,
  localParticipantId,
  isHost,
  messages,
  transcripts,
  chatDraft,
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
                    {panel === "participants" ? <Text style={styles.headerCount}> ({participants.length})</Text> : null}
                  </Text>
                </View>
                <Pressable onPress={onClose} style={styles.closeButton}>
                  <HugeiconsIcon icon={Cancel01Icon} size={20} color={Theme.colors.mutedForeground} />
                </Pressable>
              </View>

              <View style={styles.contentWrapper}>
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
                            {!isLocal ? <Text style={styles.bubbleSender}>{message.senderName}</Text> : null}
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
                  <ScrollView style={styles.panelScroll} contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
                    {panel === "participants" ? (
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
                                    {participant.role === "host" ? (
                                      <View style={styles.roleChip}>
                                        <Text style={styles.roleChipText}>Host</Text>
                                      </View>
                                    ) : null}
                                  </View>
                                  <View style={styles.participantStatusIcons}>
                                    <HugeiconsIcon icon={participant.audioEnabled ? Mic01Icon : MicOff01Icon} size={14} color={participant.audioEnabled ? Theme.colors.success : Theme.colors.error} />
                                    <HugeiconsIcon icon={participant.videoEnabled ? Video01Icon : VideoOffIcon} size={14} color={participant.videoEnabled ? Theme.colors.success : "rgba(255,255,255,0.3)"} />
                                    {participant.handRaised ? <HugeiconsIcon icon={WavingHand01Icon} size={14} color={Theme.colors.warning} /> : null}
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
                    ) : null}

                    {panel === "settings" ? (
                      <View style={styles.settingsContainer}>
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
                    ) : null}

                    {panel === "transcripts" ? (
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
                    ) : null}

                    {panel === "whiteboard" ? (
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
                    ) : null}
                  </ScrollView>
                )}
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function DeviceList({ devices, selectedId, onSelect }: { devices: readonly MediaDevice[]; selectedId: string | null; onSelect: (deviceId: string) => void }): React.JSX.Element {
  return (
    <View style={styles.deviceList}>
      {devices.map((device) => {
        const selected = device.deviceId === selectedId;
        return (
          <Pressable key={device.deviceId} onPress={() => onSelect(device.deviceId)} style={[styles.deviceRow, selected && styles.deviceRowSelected]}>
            <Text style={[styles.deviceName, selected && styles.deviceNameSelected]}>{device.label || device.deviceId}</Text>
            {selected ? <HugeiconsIcon icon={Settings01Icon} size={14} color={Theme.colors.primary} /> : null}
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
      return "Settings";
    case "transcripts":
      return "Transcript";
    case "whiteboard":
      return "Whiteboard";
    default:
      return "Panel";
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#101115",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: Platform.OS === "ios" ? 40 : 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(255,255,255,0.06)",
    ...phoneMeetingPanelSheetFrame,
  },
  dragHandle: {
    width: 42,
    height: 4,
    borderRadius: 999,
    alignSelf: "center",
    marginBottom: 14,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sheetTitle: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "800",
  },
  headerCount: {
    color: Theme.colors.mutedForeground,
    fontSize: 16,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  contentWrapper: phoneMeetingPanelContentFrame,
  chatWrapper: {
    ...phoneMeetingPanelContentFrame,
  },
  chatScroll: phoneMeetingPanelContentFrame,
  panelScroll: phoneMeetingPanelContentFrame,
  chatScrollContent: {
    gap: 12,
    paddingBottom: 18,
  },
  messageGroup: {
    gap: 6,
  },
  bubbleSender: {
    color: Theme.colors.mutedForeground,
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 4,
  },
  localBubble: {
    alignSelf: "flex-end",
    backgroundColor: Theme.colors.primary,
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "82%",
  },
  remoteBubble: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 18,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "82%",
  },
  bubbleText: {
    color: "#ffffff",
    fontSize: 14,
    lineHeight: 20,
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  input: {
    flex: 1,
    height: 48,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.04)",
    color: "#ffffff",
    paddingHorizontal: 16,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetContent: {
    gap: 18,
    paddingBottom: 8,
  },
  listContainer: {
    gap: 10,
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    gap: 12,
  },
  participantInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatarCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  participantMeta: {
    flex: 1,
    gap: 4,
  },
  participantNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  participantName: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  roleChip: {
    backgroundColor: "rgba(27, 182, 166, 0.14)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  roleChipText: {
    color: Theme.colors.primary,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  participantStatusIcons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  actionButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  iconActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  dangerActionBtn: {
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.2)",
  },
  settingsContainer: {
    gap: 14,
  },
  sectionLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.9,
  },
  deviceList: {
    gap: 8,
  },
  deviceRow: {
    minHeight: 44,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceRowSelected: {
    borderColor: "rgba(27, 182, 166, 0.4)",
    backgroundColor: "rgba(27, 182, 166, 0.08)",
  },
  deviceName: {
    color: "#ffffff",
    fontSize: 14,
    flex: 1,
    paddingRight: 12,
  },
  deviceNameSelected: {
    color: Theme.colors.primary,
    fontWeight: "700",
  },
  refreshButton: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 46,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  refreshButtonText: {
    color: Theme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  transcriptsContainer: {
    gap: 12,
  },
  transcriptEntry: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    gap: 8,
  },
  transcriptSpeaker: {
    color: Theme.colors.primary,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  transcriptDivider: {
    width: 24,
    height: 2,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  transcriptText: {
    color: "#ffffff",
    fontSize: 14,
    lineHeight: 20,
  },
  whiteboardContainer: {
    gap: 16,
  },
  statusCard: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    gap: 10,
  },
  statusHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statusTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "800",
  },
  metaText: {
    color: Theme.colors.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
  },
  buttonGrid: {
    gap: 10,
  },
  primaryPanelButton: {
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  secondaryPanelButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  secondaryButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 36,
    paddingHorizontal: 24,
  },
  emptyText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  emptySubtext: {
    color: Theme.colors.mutedForeground,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
});
