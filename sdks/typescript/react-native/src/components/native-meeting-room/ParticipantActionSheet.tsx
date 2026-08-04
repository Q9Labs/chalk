import CancelCircleIcon from "@hugeicons/core-free-icons/dist/esm/CancelCircleIcon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import UserIcon from "@hugeicons/core-free-icons/dist/esm/UserIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { Theme } from "../../ui/theme";
import { buildParticipantActionDescriptors, type AssignableParticipantRole, type ParticipantActionDescriptor } from "./space-progressive-surface-helpers";
import { CloseButton, IconTile, InitialsAvatar } from "./SpaceSurfacePrimitives";
import type { SpaceController } from "./space-progressive-surface-types";

interface ParticipantActionSheetProps {
  readonly controller: SpaceController;
  readonly participantId: string | null;
  readonly role: AssignableParticipantRole | null;
  readonly onClose: () => void;
}

export function ParticipantActionSheet({ controller, participantId, role, onClose }: ParticipantActionSheetProps): React.JSX.Element {
  const participant = participantId ? controller.participants.participants.find((item) => item.id === participantId) : undefined;
  const descriptors = role
    ? buildParticipantActionDescriptors(role, {
        canMuteParticipants: controller.canMuteParticipants,
        canRequestMedia: controller.canRequestMedia,
        canStopParticipantCamera: controller.canStopParticipantCamera,
        canStopParticipantScreenShare: controller.canStopParticipantScreenShare,
        canSetParticipantRole: controller.canSetParticipantRole,
        canTransferHost: controller.canTransferHost,
        canRemoveParticipants: controller.canRemoveParticipants,
      })
    : [];

  const run = (descriptor: ParticipantActionDescriptor) => {
    if (!participantId || !role) return;
    onClose();
    if (descriptor.kind === "mute") controller.muteParticipant(participantId);
    if (descriptor.kind === "requestUnmute") controller.requestUnmuteParticipant(participantId);
    if (descriptor.kind === "requestCamera") controller.requestStartParticipantCamera(participantId);
    if (descriptor.kind === "stopCamera") controller.stopParticipantCamera(participantId);
    if (descriptor.kind === "stopScreenShare") controller.stopParticipantScreenShare(participantId);
    if (descriptor.kind === "transferOwnership") controller.transferHost(participantId);
    if (descriptor.kind === "remove") controller.removeParticipant(participantId);
    if (descriptor.kind === "setRole") controller.setParticipantRole(participantId, role === "cohost" ? "participant" : "cohost");
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={participantId !== null}>
      <View style={styles.modalRoot}>
        <Pressable accessibilityLabel="Close Participant actions" onPress={onClose} style={styles.backdrop} />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            {participant ? <InitialsAvatar name={participant.displayName} size={44} /> : <IconTile icon={UserIcon} />}
            <View style={styles.headerCopy}>
              <Text numberOfLines={1} style={styles.name}>
                {participant?.displayName ?? "Participant"}
              </Text>
              <Text style={styles.role}>{role === "host" ? "owner" : role === "cohost" ? "collaborator" : "observer"}</Text>
            </View>
            <CloseButton label="Close Participant actions" onPress={onClose} />
          </View>
          <View style={styles.actions}>
            {descriptors
              .filter((descriptor) => !descriptor.destructive)
              .map((descriptor) => (
                <ParticipantActionRow descriptor={descriptor} key={descriptor.kind} onPress={() => run(descriptor)} />
              ))}
            {descriptors.some((descriptor) => descriptor.destructive) ? <View style={styles.divider} /> : null}
            {descriptors
              .filter((descriptor) => descriptor.destructive)
              .map((descriptor) => (
                <ParticipantActionRow descriptor={descriptor} key={descriptor.kind} onPress={() => run(descriptor)} />
              ))}
          </View>
          {!descriptors.length ? <Text style={styles.emptyText}>No actions are available for this Participant.</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

function ParticipantActionRow({ descriptor, onPress }: { readonly descriptor: ParticipantActionDescriptor; readonly onPress: () => void }): React.JSX.Element {
  const icon = descriptor.kind === "mute" || descriptor.kind === "requestUnmute" ? MicOff01Icon : descriptor.kind === "requestCamera" || descriptor.kind === "stopCamera" ? Video01Icon : descriptor.kind === "setRole" || descriptor.kind === "transferOwnership" ? UserGroupIcon : CancelCircleIcon;
  return (
    <Pressable accessibilityLabel={descriptor.label} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.actionRow, descriptor.destructive && styles.destructiveRow, pressed && styles.pressed]}>
      <HugeiconsIcon color={descriptor.destructive ? Theme.colors.error : Theme.colors.ink} icon={icon} size={21} />
      <Text style={[styles.actionLabel, descriptor.destructive && styles.destructiveText]}>{descriptor.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modalRoot: { alignItems: "center", flex: 1, justifyContent: "flex-end", paddingBottom: 112, paddingHorizontal: Theme.spacing.lg, paddingTop: Theme.spacing.lg },
  backdrop: { backgroundColor: "rgba(12,14,18,0.22)", bottom: 94, left: 0, position: "absolute", right: 0, top: 0 },
  card: { backgroundColor: Theme.colors.surface, borderColor: Theme.colors.line, borderRadius: Theme.radius.lg, elevation: 8, maxHeight: "78%", overflow: "hidden", shadowColor: Theme.colors.ink, shadowOffset: { height: 4, width: 0 }, shadowOpacity: 0.14, shadowRadius: 20, width: "100%" },
  cardHeader: { alignItems: "center", borderBottomColor: Theme.colors.line, borderBottomWidth: 1, flexDirection: "row", gap: Theme.spacing.md, minHeight: 78, paddingHorizontal: Theme.spacing.md },
  headerCopy: { flex: 1, minWidth: 0 },
  name: { color: Theme.colors.ink, fontSize: 17, fontWeight: "700" },
  role: { color: Theme.colors.ink2, fontSize: 13, marginTop: 3 },
  actions: { padding: Theme.spacing.sm },
  actionRow: { alignItems: "center", borderRadius: Theme.radius.sm, flexDirection: "row", gap: Theme.spacing.md, minHeight: 52, paddingHorizontal: Theme.spacing.md },
  actionLabel: { color: Theme.colors.ink, flex: 1, fontSize: 15 },
  destructiveRow: { backgroundColor: Theme.colors.washPink, marginTop: Theme.spacing.xs },
  destructiveText: { color: Theme.colors.error, fontWeight: "700" },
  divider: { backgroundColor: Theme.colors.line, height: 1, marginHorizontal: Theme.spacing.md, marginVertical: Theme.spacing.xs },
  emptyText: { color: Theme.colors.ink2, fontSize: 14, padding: Theme.spacing.lg },
  pressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
});
