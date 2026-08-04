import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/dist/esm/MoreHorizontalIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Theme } from "../../ui/theme";
import { ParticipantActionSheet } from "./ParticipantActionSheet";
import { displayParticipantRole, type AssignableParticipantRole } from "./space-progressive-surface-helpers";
import { InitialsAvatar } from "./SpaceSurfacePrimitives";
import type { SpaceController } from "./space-progressive-surface-types";

export function SpacePeopleSheet({ controller }: { readonly controller: SpaceController }): React.JSX.Element {
  const [actionParticipantId, setActionParticipantId] = useState<string | null>(null);
  const [actionParticipantRole, setActionParticipantRole] = useState<AssignableParticipantRole | null>(null);
  const closeActions = () => {
    setActionParticipantId(null);
    setActionParticipantRole(null);
  };
  const openActions = (participantId: string, role: AssignableParticipantRole) => {
    setActionParticipantId(participantId);
    setActionParticipantRole(role);
  };

  return (
    <View style={styles.content}>
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {controller.admissionRequests.map((request) => (
          <View key={request.admissionRequestId} style={styles.admissionRequest}>
            <InitialsAvatar name={request.displayName} size={48} />
            <View style={styles.rowCopy}>
              <Text numberOfLines={1} style={styles.name}>
                {request.displayName}
              </Text>
              <Text style={styles.meta}>At the Entrance</Text>
            </View>
            {controller.canManageAdmission ? (
              <View style={styles.admissionActions}>
                <Pressable accessibilityRole="button" onPress={() => controller.denyAdmission(request.admissionRequestId)} style={({ pressed }) => [styles.denyButton, pressed && styles.pressed]}>
                  <Text style={styles.denyText}>Deny</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => controller.admitParticipant(request.admissionRequestId)} style={({ pressed }) => [styles.admitButton, pressed && styles.pressed]}>
                  <Text style={styles.admitText}>Admit</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ))}
        {controller.participants.participants.map((participant) => {
          const local = participant.id === controller.participants.localParticipant?.id;
          const canAct = !local && canActOnParticipant(controller);
          const role = participant.role as AssignableParticipantRole;
          return (
            <View key={participant.id} style={styles.participantRow}>
              <InitialsAvatar name={participant.displayName} size={54} />
              <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={styles.name}>
                  {participant.displayName}
                  {local ? " (You)" : ""}
                </Text>
                <Text style={styles.meta}>{displayParticipantRole(role)}</Text>
              </View>
              <View style={styles.mediaStatus}>
                <HugeiconsIcon color={participant.audioEnabled ? Theme.colors.success : Theme.colors.error} icon={participant.audioEnabled ? Mic01Icon : MicOff01Icon} size={22} />
                <View style={[styles.statusDot, { backgroundColor: participant.audioEnabled ? Theme.colors.chalkGreen : Theme.colors.chalkPink }]} />
              </View>
              <View style={styles.mediaStatus}>
                <HugeiconsIcon color={participant.videoEnabled ? Theme.colors.success : Theme.colors.error} icon={participant.videoEnabled ? Video01Icon : VideoOffIcon} size={22} />
                <View style={[styles.statusDot, { backgroundColor: participant.videoEnabled ? Theme.colors.chalkGreen : Theme.colors.chalkPink }]} />
              </View>
              {canAct ? (
                <Pressable accessibilityLabel={`Actions for ${participant.displayName}`} accessibilityRole="button" onPress={() => openActions(participant.id, role)} style={({ pressed }) => [styles.moreButton, pressed && styles.pressed]}>
                  <HugeiconsIcon color={Theme.colors.ink} icon={MoreHorizontalIcon} size={22} />
                </Pressable>
              ) : null}
            </View>
          );
        })}
        {!controller.participants.participants.length && !controller.admissionRequests.length ? <EmptyPeople /> : null}
      </ScrollView>
      <ParticipantActionSheet controller={controller} onClose={closeActions} participantId={actionParticipantId} role={actionParticipantRole} />
    </View>
  );
}

function canActOnParticipant(controller: SpaceController): boolean {
  return controller.canMuteParticipants || controller.canRequestMedia || controller.canStopParticipantCamera || controller.canStopParticipantScreenShare || controller.canSetParticipantRole || controller.canTransferHost || controller.canRemoveParticipants;
}

function EmptyPeople(): React.JSX.Element {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>No People yet</Text>
      <Text style={styles.emptyText}>People will appear here as they join the Space.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, minHeight: 0 },
  list: { paddingHorizontal: Theme.spacing.lg, paddingVertical: Theme.spacing.sm },
  participantRow: { alignItems: "center", borderBottomColor: Theme.colors.line, borderBottomWidth: 1, flexDirection: "row", gap: Theme.spacing.sm, minHeight: 84, paddingVertical: Theme.spacing.md },
  rowCopy: { flex: 1, minWidth: 0, paddingHorizontal: Theme.spacing.xs },
  name: { color: Theme.colors.ink, fontSize: 16, fontWeight: "700" },
  meta: { color: Theme.colors.ink2, fontSize: 14, marginTop: 4 },
  mediaStatus: { alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 34 },
  statusDot: { borderRadius: Theme.radius.full, height: 6, marginTop: 2, width: 6 },
  moreButton: { alignItems: "center", borderColor: Theme.colors.line, borderRadius: Theme.radius.full, borderWidth: 1, height: 46, justifyContent: "center", width: 46 },
  admissionRequest: { alignItems: "center", backgroundColor: Theme.colors.washYellow, borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, flexDirection: "row", gap: Theme.spacing.sm, marginVertical: Theme.spacing.sm, padding: Theme.spacing.md },
  admissionActions: { alignItems: "center", flexDirection: "row", gap: Theme.spacing.sm },
  denyButton: { alignItems: "center", borderColor: Theme.colors.lineStrong, borderRadius: Theme.radius.sm, borderWidth: 1, justifyContent: "center", minHeight: 44, minWidth: 68, paddingHorizontal: Theme.spacing.md },
  denyText: { color: Theme.colors.ink, fontSize: 14, fontWeight: "600" },
  admitButton: { alignItems: "center", backgroundColor: Theme.colors.ink, borderRadius: Theme.radius.sm, justifyContent: "center", minHeight: 44, minWidth: 68, paddingHorizontal: Theme.spacing.md },
  admitText: { color: Theme.colors.surface, fontSize: 14, fontWeight: "700" },
  emptyState: { alignItems: "center", justifyContent: "center", minHeight: 220, paddingHorizontal: Theme.spacing["3xl"] },
  emptyTitle: { color: Theme.colors.ink, fontSize: 16, fontWeight: "700" },
  emptyText: { color: Theme.colors.ink2, fontSize: 14, marginTop: 6, textAlign: "center" },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
