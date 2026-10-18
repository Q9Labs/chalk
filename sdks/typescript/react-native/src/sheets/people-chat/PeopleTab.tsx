import type { AdmissionRequest, Participant } from "@q9labsai/chalk-client";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, View, type ListRenderItemInfo } from "react-native";
import Animated from "react-native-reanimated";
import { FaceAvatar } from "../../avatar/FaceAvatar";
import { useSpaceClient } from "../../context/space-client-context";
import { Icon } from "../../icons/Icon";
import { usePressAnimation } from "../../motion/press";
import { useCan, useParticipants, useSelf } from "../../hooks/space-hooks";
import { ChalkText } from "../../primitives/ChalkText";
import { IconButton } from "../../primitives/IconButton";
import { Menu, MenuItem } from "../../primitives/Menu";
import { PillButton } from "../../primitives/PillButton";
import { useToasts } from "../../primitives/toast/ToastStack";
import { useTheme } from "../../theme/theme";
import { fixed } from "../../theme/tokens";
import { nextHandOrder, peopleRows, type PeopleRow } from "./people-model";
import { TextField } from "./TextField";

/** Past this many people the list gets a search field. */
const SEARCH_FROM = 9;

/** The People tab: who is waiting, raised hands, and everyone in the call, with the host's actions. */
export function PeopleTab(): React.JSX.Element {
  const client = useSpaceClient();
  const toasts = useToasts();
  const { colors } = useTheme();
  const { roster, admissionQueue } = useParticipants();
  const self = useSelf();
  const canAdmit = useCan("manageAdmission");
  const canMute = useCan("muteOthers");
  const canRemove = useCan("removeParticipant");
  const canRename = useCan("renameSelf");
  const [query, setQuery] = useState("");
  const [confirmMuteAll, setConfirmMuteAll] = useState(false);
  const muteAllRef = useRef<View>(null);

  const handOrder = useRef<readonly string[]>([]);
  handOrder.current = useMemo(() => nextHandOrder(handOrder.current, roster), [roster]);
  const waiting = canAdmit ? admissionQueue : NONE;
  const rows = useMemo(() => peopleRows({ roster, waiting, handOrder: handOrder.current, query }), [roster, waiting, query]);

  const failed = useCallback(
    (what: string) => () => {
      toasts.show({ kind: "error", dismissible: true, message: `Couldn't ${what}.` });
    },
    [toasts],
  );
  const admit = useCallback((request: AdmissionRequest) => client.participants.admit(request.requestId).catch(failed(`let ${request.displayName} in`)), [client, failed]);
  const deny = useCallback((request: AdmissionRequest) => client.participants.deny(request.requestId).catch(failed(`deny ${request.displayName}`)), [client, failed]);
  const mute = useCallback((participant: Participant) => client.participants.mute(participant.participantId).catch(failed(`mute ${participant.displayName}`)), [client, failed]);
  const remove = useCallback((participant: Participant) => client.participants.remove(participant.participantId).catch(failed(`remove ${participant.displayName}`)), [client, failed]);
  const rename = useCallback((name: string) => client.participants.renameSelf(name).catch(failed("change your name")), [client, failed]);

  const loud = useMemo(() => roster.filter((participant) => participant.participantId !== self.participantId && participant.media.microphone === "active"), [roster, self.participantId]);
  const muteAll = useCallback(() => {
    setConfirmMuteAll(false);
    Promise.all(loud.map((participant) => client.participants.mute(participant.participantId))).catch(failed("mute everyone"));
  }, [client, failed, loud]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<PeopleRow>) => {
      switch (item.kind) {
        case "section":
          return <SectionLabel label={item.label} />;
        case "waiting":
          return <WaitingRow onAdmit={admit} onDeny={deny} request={item.request} />;
        case "hand":
          return <HandRow isSelf={item.participant.participantId === self.participantId} order={item.order} participant={item.participant} />;
        case "none":
          return (
            <ChalkText style={styles.none} tone="textMuted" variant="meta">
              {item.query ? `No one in the call matches “${item.query}”.` : "No one else is in the call."}
            </ChalkText>
          );
        case "person": {
          const isSelf = item.participant.participantId === self.participantId;
          return <PersonRow canMute={canMute && !isSelf} canRemove={canRemove && !isSelf} canRename={canRename && isSelf} handNumber={item.handNumber} isSelf={isSelf} onMute={mute} onRemove={remove} onRename={rename} participant={item.participant} />;
        }
      }
    },
    [admit, canMute, canRemove, canRename, deny, mute, remove, rename, self.participantId],
  );

  const header = (
    <View>
      {canMute ? (
        <View style={styles.controls}>
          <HostChip disabled={loud.length === 0} expanded={confirmMuteAll} onPress={() => setConfirmMuteAll(true)} ref={muteAllRef} />
        </View>
      ) : null}
      {roster.length >= SEARCH_FROM ? (
        <View style={[styles.search, { backgroundColor: colors.raised }]}>
          <Icon color={colors.textMuted} name="search" size={16} />
          <TextField accessibilityLabel="Search people" autoCapitalize="none" autoCorrect={false} onChangeText={setQuery} placeholder="Search people" returnKeyType="search" testID="people.search" value={query} />
        </View>
      ) : null}
    </View>
  );

  return (
    <>
      <FlatList contentContainerStyle={styles.content} data={rows} initialNumToRender={12} keyboardShouldPersistTaps="handled" keyExtractor={(row) => row.key} ListHeaderComponent={header} maxToRenderPerBatch={12} renderItem={renderItem} style={styles.list} testID="people.list" windowSize={7} />
      <Menu accessibilityLabel="Mute everyone" anchorRef={muteAllRef} minWidth={280} onClose={() => setConfirmMuteAll(false)} open={confirmMuteAll} testID="people.mute-all.confirm">
        <View style={styles.confirm}>
          <ChalkText variant="cardTitle">Mute everyone?</ChalkText>
          <ChalkText style={styles.confirmText} tone="textSoft" variant="meta">
            {`${loud.length} ${loud.length === 1 ? "person" : "people"} will be muted. They can unmute themselves.`}
          </ChalkText>
          <View style={styles.confirmButtons}>
            <PillButton label="Cancel" onPress={() => setConfirmMuteAll(false)} size="sm" testID="people.mute-all.cancel" />
            <PillButton label="Mute everyone" onPress={muteAll} size="sm" testID="people.mute-all.confirm-button" variant="primary" />
          </View>
        </View>
      </Menu>
    </>
  );
}

const NONE: readonly AdmissionRequest[] = [];

type HostChipProps = { readonly disabled: boolean; readonly expanded: boolean; readonly onPress: () => void; readonly ref: React.Ref<View> };

/** `.hcb`: Mute everyone, dimmed once everyone else is muted. */
function HostChip({ disabled, expanded, onPress, ref }: HostChipProps): React.JSX.Element {
  const { colors } = useTheme();
  const press = usePressAnimation("pill");
  return (
    <Pressable accessibilityHint="Asks you to confirm" accessibilityLabel="Mute everyone" accessibilityRole="button" accessibilityState={{ disabled, expanded }} disabled={disabled} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} ref={ref} testID="people.mute-all">
      {({ pressed }) => (
        <Animated.View style={[styles.chip, { backgroundColor: pressed || expanded ? colors.hover : colors.raised }, disabled ? styles.disabled : press.scaleStyle]}>
          <Icon color={colors.textMuted} name="micOff" size={16} />
          <ChalkText variant="button">Mute everyone</ChalkText>
        </Animated.View>
      )}
    </Pressable>
  );
}

const SectionLabel = memo(function SectionLabel({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <View accessibilityRole="header" accessible style={styles.section}>
      <ChalkText tone="textMuted" variant="section">
        {label}
      </ChalkText>
    </View>
  );
});

function Face({ name }: { readonly name: string }): React.JSX.Element {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <FaceAvatar name={name} size={32} />
    </View>
  );
}

const WaitingRow = memo(function WaitingRow({ request, onAdmit, onDeny }: { readonly request: AdmissionRequest; readonly onAdmit: (request: AdmissionRequest) => void; readonly onDeny: (request: AdmissionRequest) => void }): React.JSX.Element {
  return (
    <View style={styles.row} testID={`people.waiting.${request.participantId}`}>
      <Face name={request.displayName} />
      <ChalkText numberOfLines={1} style={styles.name} variant="bodyMedium">
        {request.displayName}
      </ChalkText>
      <PillButton accessibilityLabel={`Deny ${request.displayName}`} label="Deny" onPress={() => onDeny(request)} size="sm" testID={`people.deny.${request.participantId}`} />
      <PillButton accessibilityLabel={`Let ${request.displayName} in`} label="Let in" onPress={() => onAdmit(request)} size="sm" testID={`people.admit.${request.participantId}`} variant="primary" />
    </View>
  );
});

const HandRow = memo(function HandRow({ participant, order, isSelf }: { readonly participant: Participant; readonly order: number; readonly isSelf: boolean }): React.JSX.Element {
  return (
    <View accessible accessibilityLabel={`${participant.displayName}${isSelf ? " (You)" : ""}, hand raised, number ${order}`} style={[styles.row, styles.handRow]} testID={`people.hand.${participant.participantId}`}>
      <View style={styles.handNumber}>
        <ChalkText color={fixed.handText} variant="section">
          {order}
        </ChalkText>
      </View>
      <Face name={participant.displayName} />
      <ChalkText numberOfLines={1} style={styles.name} variant="bodyMedium">
        {participant.displayName}
        {isSelf ? (
          <ChalkText tone="textMuted" variant="meta">
            {"  (You)"}
          </ChalkText>
        ) : null}
      </ChalkText>
    </View>
  );
});

type PersonRowProps = {
  readonly participant: Participant;
  readonly isSelf: boolean;
  readonly handNumber: number | null;
  readonly canMute: boolean;
  readonly canRemove: boolean;
  readonly canRename: boolean;
  readonly onMute: (participant: Participant) => void;
  readonly onRemove: (participant: Participant) => void;
  readonly onRename: (name: string) => void;
};

const PersonRow = memo(function PersonRow({ participant, isSelf, handNumber, canMute, canRemove, canRename, onMute, onRemove, onRename }: PersonRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(participant.displayName);
  const optionsRef = useRef<View>(null);
  const host = participant.capabilities.includes("endEpisode");
  const micOff = participant.media.microphone === "inactive";
  const canMuteNow = canMute && participant.media.microphone === "active";
  const hasOptions = canRename || canMuteNow || canRemove;

  const save = () => {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== participant.displayName) onRename(name);
  };

  if (renaming) {
    return (
      <View style={styles.row} testID="people.rename">
        <Face name={participant.displayName} />
        <View style={[styles.rename, { backgroundColor: colors.raised, boxShadow: `0px 0px 0px 2px ${colors.text}` }]}>
          <TextField accessibilityLabel="Your name" autoFocus maxLength={40} onChangeText={setDraft} onSubmitEditing={save} returnKeyType="done" selectTextOnFocus testID="people.rename.input" value={draft} />
        </View>
        <PillButton label="Save" onPress={save} size="sm" testID="people.rename.save" variant="primary" />
      </View>
    );
  }

  const status = [isSelf ? "You" : null, host ? "Host" : null, participant.handRaised ? `hand raised${handNumber ? `, number ${handNumber}` : ""}` : null, micOff ? "microphone off" : null].filter(Boolean).join(", ");
  return (
    <View style={styles.row} testID={`people.row.${participant.participantId}`}>
      <Face name={participant.displayName} />
      <ChalkText accessibilityLabel={status ? `${participant.displayName}, ${status}` : participant.displayName} numberOfLines={1} style={styles.name} variant="bodyMedium">
        {participant.displayName}
        {isSelf ? (
          <ChalkText tone="textMuted" variant="meta">
            {"  (You)"}
          </ChalkText>
        ) : null}
        {host ? (
          <ChalkText tone="textMuted" variant="meta">
            {"  Host"}
          </ChalkText>
        ) : null}
      </ChalkText>
      {participant.handRaised ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.status}>
          <Icon color={colors.warning} name="hand" size={16} />
          {handNumber ? (
            <ChalkText color={colors.warning} style={styles.statusNumber} variant="caption">
              {handNumber}
            </ChalkText>
          ) : null}
        </View>
      ) : null}
      {micOff ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.status}>
          <Icon color={colors.dangerText} name="micOff" size={16} />
        </View>
      ) : null}
      {hasOptions ? <IconButton accessibilityLabel={`Options for ${participant.displayName}`} expanded={menuOpen} icon="more" onPress={() => setMenuOpen(true)} ref={optionsRef} size={36} testID={`people.options.${participant.participantId}`} tone="ghost" /> : null}
      <Menu accessibilityLabel="Person options" anchorRef={optionsRef} onClose={() => setMenuOpen(false)} open={menuOpen} testID="people.menu">
        {canRename ? (
          <MenuItem
            icon="edit"
            label="Edit name"
            onPress={() => {
              setMenuOpen(false);
              setDraft(participant.displayName);
              setRenaming(true);
            }}
            testID="people.menu.rename"
          />
        ) : null}
        {canMuteNow ? (
          <MenuItem
            icon="micOff"
            label="Mute"
            onPress={() => {
              setMenuOpen(false);
              onMute(participant);
            }}
            testID="people.menu.mute"
          />
        ) : null}
        {canRemove ? (
          <MenuItem
            danger
            icon="x"
            label="Remove from call"
            onPress={() => {
              setMenuOpen(false);
              onRemove(participant);
            }}
            testID="people.menu.remove"
          />
        ) : null}
      </Menu>
    </View>
  );
});

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { padding: 8, paddingBottom: 16 },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginHorizontal: 2, marginTop: 2, marginBottom: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingLeft: 10, paddingRight: 12, borderRadius: 999 },
  disabled: { opacity: 0.45 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, height: 40, marginHorizontal: 2, marginTop: 2, marginBottom: 8, paddingHorizontal: 14, borderRadius: 999 },
  section: { paddingTop: 10, paddingHorizontal: 8, paddingBottom: 6 },
  none: { paddingVertical: 16, paddingHorizontal: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingLeft: 8, paddingRight: 4, borderRadius: 12 },
  handRow: { gap: 8 },
  name: { flex: 1 },
  handNumber: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: fixed.hand },
  status: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  statusNumber: { marginLeft: 1, fontWeight: "700" },
  rename: { flex: 1, flexDirection: "row", alignItems: "center", height: 36, paddingHorizontal: 12, borderRadius: 999 },
  confirm: { paddingTop: 8, paddingHorizontal: 8, paddingBottom: 4 },
  confirmText: { marginTop: 4, marginBottom: 10 },
  confirmButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4, marginHorizontal: 6 },
});
