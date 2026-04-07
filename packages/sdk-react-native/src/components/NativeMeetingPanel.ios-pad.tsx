import { type ChatMessage, type MediaDevice, type Transcript } from "@q9labs/chalk-core";
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
import { HugeiconsIcon } from "@hugeicons/react-native";
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, Modal, TouchableWithoutFeedback } from "react-native";
import { Theme } from "../ui/theme";
import { NativeFaceAvatar } from "./NativeFaceAvatar";
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
  onChatDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onClose: () => void;
  onSelectCamera: (deviceId: string) => void;
  onSelectMicrophone: (deviceId: string) => void;
  onSelectSpeaker: (deviceId: string) => void;
  onRefreshDevices: () => void;
  onMuteParticipant: (participantId: string) => void;
  onUnmuteParticipant: (participantId: string) => void;
}

export function NativeMeetingPanelIosPad({
  panel,
  participants,
  localParticipantId,
  isHost,
  messages,
  chatDraft,
  cameras,
  microphones,
  speakers,
  selectedCamera,
  selectedMicrophone,
  selectedSpeaker,
  isRefreshingDevices,
  onChatDraftChange,
  onSendMessage,
  onClose,
  onSelectCamera,
  onSelectMicrophone,
  onSelectSpeaker,
  onRefreshDevices,
  onMuteParticipant,
  onUnmuteParticipant,
}: NativeMeetingPanelProps): React.JSX.Element | null {
  if (!panel) return null;

  return (
    <Modal animationType="slide" transparent={true} visible={!!panel} onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <View style={styles.dragHandle} />
              
              <View style={styles.header}>
                <View style={styles.titleGroup}>
                  <HugeiconsIcon icon={panelIcon(panel)} size={20} color={Theme.colors.primary} />
                  <Text style={styles.title}>
                    {panelTitle(panel)}
                    {panel === "participants" ? <Text style={styles.count}> ({participants.length})</Text> : null}
                  </Text>
                </View>
                <Pressable onPress={onClose} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
                  <HugeiconsIcon icon={Cancel01Icon} size={20} color={Theme.colors.mutedForeground} />
                </Pressable>
              </View>

              <View style={styles.contentWrapper}>
                {panel === "chat" ? (
                  <View style={styles.chatContainer}>
                    <ScrollView style={styles.chatScroll} contentContainerStyle={styles.chatScrollContent} showsVerticalScrollIndicator={false}>
                      {messages.length === 0 ? (
                        <View style={styles.emptyState}>
                          <HugeiconsIcon icon={Chat01Icon} size={48} color="rgba(255,255,255,0.05)" />
                          <Text style={styles.emptyText}>No messages yet</Text>
                        </View>
                      ) : null}
                      {messages.map((message, index) => {
                        const isLocal = message.senderId === localParticipantId;
                        return (
                          <View key={`${message.id ?? "msg"}-${index}`} style={[styles.msgRow, isLocal && styles.msgRowLocal]}>
                            {!isLocal && <Text style={styles.msgSender}>{message.senderName}</Text>}
                            <View style={[styles.bubble, isLocal ? styles.bubbleLocal : styles.bubbleRemote]}>
                              <Text style={styles.bubbleText}>{message.content}</Text>
                            </View>
                          </View>
                        );
                      })}
                    </ScrollView>
                    <View style={styles.composer}>
                      <TextInput 
                        onChangeText={onChatDraftChange} 
                        onSubmitEditing={onSendMessage} 
                        placeholder="Send a message..." 
                        placeholderTextColor={Theme.colors.placeholder} 
                        style={styles.composerInput} 
                        value={chatDraft} 
                      />
                      <Pressable onPress={onSendMessage} style={styles.sendAction}>
                        <HugeiconsIcon icon={ArrowUp01Icon} size={20} color="white" />
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <ScrollView contentContainerStyle={styles.listPadding} showsVerticalScrollIndicator={false}>
                    {panel === "participants" && (
                      <View style={styles.list}>
                        {participants.map((participant, index) => {
                          const isLocal = participant.id === localParticipantId;
                          return (
                            <View key={`${participant.id}-${index}`} style={styles.pRow}>
                              <View style={styles.pAvatar}>
                                <NativeFaceAvatar name={participant.displayName} size={40} />
                              </View>
                              <View style={styles.pMeta}>
                                <Text style={styles.pName} numberOfLines={1}>
                                  {participant.displayName}{isLocal ? " (You)" : ""}
                                </Text>
                                <View style={styles.pStatus}>
                                  <HugeiconsIcon icon={participant.audioEnabled ? Mic01Icon : MicOff01Icon} size={12} color={participant.audioEnabled ? Theme.colors.success : Theme.colors.error} />
                                  <HugeiconsIcon icon={participant.videoEnabled ? Video01Icon : VideoOffIcon} size={12} color={participant.videoEnabled ? Theme.colors.success : "rgba(255,255,255,0.2)"} />
                                </View>
                              </View>
                              {isHost && !isLocal && (
                                <View style={styles.pActions}>
                                  <Pressable onPress={() => (participant.audioEnabled ? onMuteParticipant(participant.id) : onUnmuteParticipant(participant.id))} style={styles.pActionBtn}>
                                    <HugeiconsIcon icon={participant.audioEnabled ? MicOff01Icon : Mic01Icon} size={16} color="white" />
                                  </Pressable>
                                </View>
                              )}
                            </View>
                          );
                        })}
                      </View>
                    )}

                    {panel === "settings" && (
                      <View style={styles.settings}>
                        <SettingSection label="Camera" devices={cameras} selected={selectedCamera} onSelect={onSelectCamera} />
                        <SettingSection label="Microphone" devices={microphones} selected={selectedMicrophone} onSelect={onSelectMicrophone} />
                        <SettingSection label="Speaker" devices={speakers} selected={selectedSpeaker} onSelect={onSelectSpeaker} />
                        
                        <Pressable onPress={onRefreshDevices} style={styles.refreshBtn}>
                          <HugeiconsIcon icon={Refresh01Icon} size={16} color={Theme.colors.primary} />
                          <Text style={styles.refreshBtnText}>{isRefreshingDevices ? "Refreshing..." : "Refresh Devices"}</Text>
                        </Pressable>
                      </View>
                    )}
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

function SettingSection({ label, devices, selected, onSelect }: { label: string; devices: readonly MediaDevice[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <View style={styles.sSection}>
      <Text style={styles.sLabel}>{label}</Text>
      <View style={styles.sList}>
        {devices.map((d) => {
          const isSel = d.deviceId === selected;
          return (
            <Pressable key={d.deviceId} onPress={() => onSelect(d.deviceId)} style={[styles.sRow, isSel && styles.sRowSel]}>
              <Text style={[styles.sName, isSel && styles.sNameSel]} numberOfLines={1}>{d.label || "Default Device"}</Text>
              {isSel && <View style={styles.sDot} />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function panelTitle(panel: NativeMeetingPanelName | null): string {
  switch (panel) {
    case "chat": return "Chat";
    case "participants": return "Participants";
    case "settings": return "Settings";
    case "transcripts": return "Transcript";
    case "whiteboard": return "Whiteboard";
    default: return "Panel";
  }
}

function panelIcon(panel: NativeMeetingPanelName | null): any {
  switch (panel) {
    case "chat": return Chat01Icon;
    case "participants": return UserGroupIcon;
    case "settings": return Settings01Icon;
    case "transcripts": return TextFontIcon;
    case "whiteboard": return Presentation01Icon;
    default: return Settings01Icon;
  }
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  sheet: {
    width: "100%",
    maxWidth: 640,
    height: "75%",
    backgroundColor: "rgba(10, 10, 12, 0.95)",
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 20,
  },
  dragHandle: {
    width: 48,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignSelf: "center",
    marginTop: 12,
    marginBottom: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  titleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  title: {
    color: "white",
    fontSize: 18,
    fontWeight: "800",
  },
  count: {
    color: Theme.colors.mutedForeground,
    fontWeight: "600",
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
  contentWrapper: {
    flex: 1,
  },
  chatContainer: {
    flex: 1,
  },
  chatScroll: {
    flex: 1,
  },
  chatScrollContent: {
    padding: 20,
    gap: 16,
  },
  msgRow: {
    gap: 4,
    maxWidth: "85%",
  },
  msgRowLocal: {
    alignSelf: "flex-end",
  },
  msgSender: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    fontWeight: "700",
    marginLeft: 4,
  },
  bubble: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  bubbleLocal: {
    backgroundColor: Theme.colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleRemote: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    color: "white",
    fontSize: 14,
    lineHeight: 20,
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    paddingBottom: 32,
    backgroundColor: "rgba(0,0,0,0.2)",
    gap: 12,
  },
  composerInput: {
    flex: 1,
    height: 52,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 26,
    paddingHorizontal: 20,
    color: "white",
    fontSize: 16,
  },
  sendAction: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  listPadding: {
    padding: 24,
  },
  list: {
    gap: 12,
  },
  pRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.03)",
    padding: 12,
    borderRadius: 20,
  },
  pAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: "hidden",
  },
  pMeta: {
    flex: 1,
    gap: 4,
  },
  pName: {
    color: "white",
    fontSize: 15,
    fontWeight: "700",
  },
  pStatus: {
    flexDirection: "row",
    gap: 8,
  },
  pActions: {
    flexDirection: "row",
    gap: 8,
  },
  pActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  settings: {
    gap: 32,
  },
  sSection: {
    gap: 12,
  },
  sLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 2,
  },
  sList: {
    gap: 8,
  },
  sRow: {
    height: 52,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 16,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sRowSel: {
    backgroundColor: "rgba(27, 182, 166, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.2)",
  },
  sName: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 15,
    fontWeight: "600",
  },
  sNameSel: {
    color: Theme.colors.primary,
  },
  sDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Theme.colors.primary,
  },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.2)",
  },
  refreshBtnText: {
    color: Theme.colors.primary,
    fontSize: 15,
    fontWeight: "700",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 100,
    gap: 16,
  },
  emptyText: {
    color: Theme.colors.mutedForeground,
    fontSize: 16,
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.7,
  },
});
