import type { ScreenAnnotationCommand, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../icons/Icon";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import { visibleCommittedMarks, type Ink, type Tool } from "./model";

const toolRows: ReadonlyArray<ReadonlyArray<{ readonly tool: Tool; readonly label: string; readonly glyph?: string; readonly icon?: IconName }>> = [
  [{ tool: "laser", label: "Laser", glyph: "•" }, { tool: "pen", label: "Pen", icon: "pen" }, { tool: "highlighter", label: "Highlight", glyph: "▰" }, { tool: "line", label: "Line", glyph: "╱" }, { tool: "arrow", label: "Arrow", glyph: "↗" }],
  [{ tool: "box", label: "Box", glyph: "□" }, { tool: "circle", label: "Circle", glyph: "○" }, { tool: "text", label: "Text", glyph: "T" }, { tool: "stamp", label: "Stamp", glyph: "☆" }, { tool: "eraser", label: "Erase", icon: "trash" }],
];
const stamps = [["check", "✓"], ["cross", "✗"], ["star", "★"], ["question", "?"], ["heart", "♥"]] as const;
const widths = [[193, "Fine"], [360, "Medium"], [720, "Wide"]] as const;
const colors = [["#ff6b74", "Red"], ["#ffb15c", "Orange"], ["#fde05a", "Yellow"], ["#67ddaa", "Green"], ["#56b5ff", "Blue"], ["#b48aff", "Purple"], ["#ffffff", "White"]] as const;

type Person = { readonly id: string; readonly name: string; readonly canDraw: boolean; readonly manages: boolean };
export type ScreenAnnotationToolbarProps = {
  readonly state: ScreenAnnotationState;
  readonly participantId: string;
  readonly ink: Ink;
  readonly drawingAllowed: boolean;
  readonly canRequestDraw: boolean;
  readonly serverNowMs: () => number;
  readonly people?: readonly Person[];
  readonly onInk: (next: Ink) => void;
  readonly onCommand: (command: ScreenAnnotationCommand) => void;
  readonly onClose: () => void;
  readonly onSave?: () => void;
  readonly onDownload?: () => void;
};

export function ScreenAnnotationToolbar({ state, participantId, ink, drawingAllowed, canRequestDraw, serverNowMs, people = [], onInk, onCommand, onClose, onSave, onDownload }: ScreenAnnotationToolbarProps): React.JSX.Element {
  const { colors: theme } = useTheme();
  const [menu, setMenu] = useState<"format" | "manage" | "authors" | null>(null);
  const { access, layer } = state;
  const nowMs = serverNowMs();
  const pending = access.requests.some((request) => request.participant_id === participantId && request.expires_at_ms > nowMs);
  const open = (panel: typeof menu) => setMenu(menu === panel ? null : panel);
  const paused = state.paused && participantId !== layer.sharer_id;
  const canModerate = access.can_moderate;
  const canManagePolicy = access.can_manage_policy;
  const authors = menu === "authors"
    ? [...new Map(visibleCommittedMarks(state, nowMs).map(({ author }) => [author.participant_id, author])).values()]
    : [];

  return (
    <View testID="annotation.tray" style={[styles.tray, { backgroundColor: theme.popover, borderColor: theme.lineStrong }]}>
      <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        {drawingAllowed ? (
          <>
            {ink.tool === "stamp" ? <View style={styles.row}>{stamps.map(([stamp, glyph]) => <ToolButton key={stamp} label={stamp} glyph={glyph} selected={ink.stamp === stamp} onPress={() => onInk({ ...ink, stamp })} />)}</View> : null}
            {toolRows.map((row, index) => <View style={styles.row} key={index}>{row.map(({ tool, ...visual }) => <ToolButton key={tool} {...visual} selected={ink.tool === tool} onPress={() => onInk({ ...ink, tool })} />)}</View>)}
            <View style={styles.row}>
              <ToolButton label="Ink style" color={ink.color} selected={menu === "format"} onPress={() => open("format")} />
              <ToolButton label={ink.lifetime === "keep" ? "Kept" : "Fade"} selected={ink.lifetime === "keep"} onPress={() => onInk({ ...ink, lifetime: ink.lifetime === "keep" ? "fade" : "keep" })} />
              <ToolButton label="Undo" icon="undo" onPress={() => onCommand({ kind: "undo" })} />
              <ToolButton label="Redo" icon="redo" onPress={() => onCommand({ kind: "redo" })} />
            </View>
            {menu === "format" ? (
              <>
                <View style={styles.row}>{[[access.default_color, "Assigned color"], ...colors].map(([color, label]) => color && label ? <ToolButton key={label} label={label} color={color} iconOnly selected={ink.color === color} onPress={() => onInk({ ...ink, color })} /> : null)}</View>
                <View style={styles.row}>{widths.map(([width, label]) => <ToolButton key={width} label={label} selected={width === ink.width} onPress={() => onInk({ ...ink, width })} />)}</View>
              </>
            ) : null}
          </>
        ) : (
          <View style={styles.notice}>
            <ChalkText>{paused ? "Marks are paused" : access.draw_policy === "hosts" ? "Only hosts can draw" : pending ? "Request sent" : "You don’t have permission to draw"}</ChalkText>
            {canRequestDraw && !paused && !pending ? <ToolButton label="Request to draw" onPress={() => onCommand({ kind: "request_draw" })} /> : null}
          </View>
        )}
        <View style={styles.row}>
          <ToolButton label="Clear mine" onPress={() => onCommand({ kind: "clear", scope: { kind: "mine" } })} />
          {state.marks.length || menu === "authors" ? <ToolButton label="Mark authors" selected={menu === "authors"} onPress={() => open("authors")} /> : null}
          {canModerate || canManagePolicy ? <ToolButton label="Manage marks" selected={menu === "manage"} onPress={() => open("manage")} /> : null}
          {onSave ? <ToolButton label="Add to board" onPress={onSave} /> : null}
          {onDownload ? <ToolButton label="Save PNG" onPress={onDownload} /> : null}
          <ToolButton label="Done" selected onPress={onClose} />
        </View>
        {menu === "authors" ? (
          authors.length ? authors.map((author) => <View key={author.participant_id} style={styles.person}>
            <View style={[styles.swatch, { backgroundColor: author.color }]} />
            <ChalkText>{author.display_name}</ChalkText>
          </View>) : <ChalkText>No visible marks</ChalkText>
        ) : null}
        {menu === "manage" ? (
          <>
            {canModerate ? <View style={styles.row}>
              <ToolButton label={state.paused ? "Resume marks" : "Pause marks"} onPress={() => onCommand({ kind: "pause", paused: !state.paused })} />
              <ToolButton label="Clear all" onPress={() => onCommand({ kind: "clear", scope: { kind: "all" } })} />
            </View> : null}
            {canManagePolicy ? <View style={styles.row}>{(["everyone", "hosts", "picked"] as const).map((policy) => <ToolButton key={policy} label={{ everyone: "Everyone", hosts: "Hosts only", picked: "Picked people" }[policy]} selected={access.draw_policy === policy} onPress={() => onCommand({ kind: "set_policy", policy })} />)}</View> : null}
            {people.map((person) => {
              const request = access.requests.find((value) => value.participant_id === person.id && value.expires_at_ms > nowMs);
              return <View key={person.id} style={styles.person}>
                <ChalkText numberOfLines={1} style={styles.personName}>{person.name}</ChalkText>
                {canManagePolicy && request ? <>
                  <ToolButton label="Allow" onPress={() => onCommand({ kind: "decide_draw", request_id: request.request_id, allow: true })} />
                  <ToolButton label="Decline" onPress={() => onCommand({ kind: "decide_draw", request_id: request.request_id, allow: false })} />
                </> : canManagePolicy && !person.manages && access.draw_policy !== "hosts" ? <ToolButton label={person.canDraw ? "Block" : "Allow"} onPress={() => onCommand({ kind: "set_draw_permission", participant_id: person.id, allow: !person.canDraw })} /> : null}
                {canModerate ? <ToolButton label="Clear" onPress={() => onCommand({ kind: "clear", scope: { kind: "participant", participant_id: person.id } })} /> : null}
              </View>;
            })}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

export function ToolButton({ label, icon, glyph, color, iconOnly, selected, onPress }: { readonly label: string; readonly icon?: IconName; readonly glyph?: string; readonly color?: string; readonly iconOnly?: boolean; readonly selected?: boolean; readonly onPress: () => void }): React.JSX.Element {
  const { colors: theme } = useTheme();
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={selected === undefined ? undefined : { selected }}
    onPress={onPress}
    style={[styles.button, { backgroundColor: selected ? theme.focus : theme.raised, borderColor: theme.lineStrong }]}
    testID={`annotation.${label.toLowerCase().replaceAll(" ", "-")}`}
  >
    {icon ? <Icon name={icon} color={selected ? theme.canvas : theme.text} size={17} /> : null}
    {glyph ? <ChalkText style={styles.glyph} color={selected ? theme.canvas : theme.text}>{glyph}</ChalkText> : null}
    {color ? <View style={[styles.swatch, { backgroundColor: color }]} /> : null}
    {!iconOnly ? <ChalkText style={styles.label} numberOfLines={1} adjustsFontSizeToFit color={selected ? theme.canvas : theme.text}>{label}</ChalkText> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  tray: { alignSelf: "center", width: "100%", maxWidth: 540, maxHeight: "100%", borderWidth: 1, borderRadius: 24, overflow: "hidden" },
  body: { padding: 8, gap: 5 },
  row: { flexDirection: "row", alignItems: "stretch", gap: 4 },
  button: { alignItems: "center", justifyContent: "center", minHeight: 44, flexGrow: 1, flexBasis: 0, paddingHorizontal: 2, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, gap: 2 },
  glyph: { fontSize: 21, lineHeight: 23 },
  label: { fontSize: 11, lineHeight: 15 },
  swatch: { width: 14, height: 14, borderRadius: 7 },
  notice: { alignItems: "center", flexDirection: "row", gap: 8 },
  person: { flexDirection: "row", alignItems: "center", gap: 6 },
  personName: { flex: 2 },
});
