import { corners, fontSizes, radii, space } from "../theme/tokens";
import type { ScreenAnnotationCommand, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { Icon, type IconName } from "../icons/Icon";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import { visibleCommittedMarks, type Ink, type Tool } from "./model";

type ToolVisual = { readonly label: string; readonly icon?: IconName; readonly path?: string; readonly circle?: true };
// The icon set has no highlighter, line, arrow, circle or star, so these draw in the same 24-unit line style.
const toolRows: ReadonlyArray<ReadonlyArray<ToolVisual & { readonly tool: Tool }>> = [
  [
    { tool: "laser", label: "Laser", icon: "pointer" },
    { tool: "pen", label: "Pen", icon: "pen" },
    { tool: "highlighter", label: "Highlight", path: "M4 20h6l9-9-6-6-9 9zM13 5l6 6M3 22h18" },
    { tool: "line", label: "Line", path: "M5 19L19 5" },
    { tool: "arrow", label: "Arrow", path: "M5 19L19 5M9 5h10v10" },
  ],
  [
    { tool: "box", label: "Box", icon: "square" },
    { tool: "circle", label: "Circle", circle: true },
    { tool: "text", label: "Text", icon: "type" },
    { tool: "stamp", label: "Stamp", path: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" },
    { tool: "eraser", label: "Erase", icon: "eraser" },
  ],
];
const stamps = [
  ["check", "✓"],
  ["cross", "✗"],
  ["star", "★"],
  ["question", "?"],
  ["heart", "♥"],
] as const;
const widths = [
  [193, "Fine"],
  [360, "Medium"],
  [720, "Wide"],
] as const;
const colors = [
  ["#ff6b74", "Red"],
  ["#ffb15c", "Orange"],
  ["#fde05a", "Yellow"],
  ["#67ddaa", "Green"],
  ["#56b5ff", "Blue"],
  ["#b48aff", "Purple"],
  ["#ffffff", "White"],
] as const;

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
  const authors = menu === "authors" ? [...new Map(visibleCommittedMarks(state, nowMs).map(({ author }) => [author.participant_id, author])).values()] : [];

  return (
    <View testID="annotation.tray" style={[styles.tray, { backgroundColor: theme.popover, borderColor: theme.lineStrong }]}>
      <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        {drawingAllowed ? (
          <InkControls ink={ink} assignedColor={access.default_color} formatOpen={menu === "format"} onInk={onInk} onCommand={onCommand} onToggleFormat={() => open("format")} />
        ) : (
          <View style={styles.notice}>
            <ChalkText>{paused ? "Marks are paused" : access.draw_policy === "hosts" ? "Only hosts can draw" : pending ? "Request sent" : "You don’t have permission to draw"}</ChalkText>
            {canRequestDraw && !paused && !pending ? <ToolButton label="Request to draw" onPress={() => onCommand({ kind: "request_draw" })} /> : null}
          </View>
        )}
        <View style={[styles.rule, { backgroundColor: theme.line }]} />
        <View style={styles.row}>
          <ToolButton label="Clear mine" onPress={() => onCommand({ kind: "clear", scope: { kind: "mine" } })} />
          {state.marks.length || menu === "authors" ? <ToolButton label="Mark authors" selected={menu === "authors"} onPress={() => open("authors")} /> : null}
          {canModerate || canManagePolicy ? <ToolButton label="Manage marks" selected={menu === "manage"} onPress={() => open("manage")} /> : null}
          {onSave ? <ToolButton label="Add to board" onPress={onSave} /> : null}
          {onDownload ? <ToolButton label="Save PNG" onPress={onDownload} /> : null}
          <ToolButton label="Done" selected onPress={onClose} />
        </View>
        {menu === "authors" ? (
          authors.length ? (
            authors.map((author) => (
              <View key={author.participant_id} style={styles.person}>
                <View style={[styles.swatch, { backgroundColor: author.color }]} />
                <ChalkText>{author.display_name}</ChalkText>
              </View>
            ))
          ) : (
            <ChalkText>No visible marks</ChalkText>
          )
        ) : null}
        {menu === "manage" ? <ManageMarks state={state} people={people} nowMs={nowMs} onCommand={onCommand} /> : null}
      </ScrollView>
    </View>
  );
}

function InkControls({ ink, assignedColor, formatOpen, onInk, onCommand, onToggleFormat }: Pick<ScreenAnnotationToolbarProps, "ink" | "onInk" | "onCommand"> & { readonly assignedColor: string; readonly formatOpen: boolean; readonly onToggleFormat: () => void }) {
  return (
    <>
      {ink.tool === "stamp" ? (
        <View style={styles.row}>
          {stamps.map(([stamp, glyph]) => (
            <ToolButton key={stamp} label={stamp} glyph={glyph} selected={ink.stamp === stamp} onPress={() => onInk({ ...ink, stamp })} />
          ))}
        </View>
      ) : null}
      {toolRows.map((row, index) => (
        <View style={styles.row} key={index}>
          {row.map(({ tool, ...visual }) => (
            <ToolButton key={tool} {...visual} selected={ink.tool === tool} onPress={() => onInk({ ...ink, tool })} />
          ))}
        </View>
      ))}
      <View style={styles.row}>
        <ToolButton label="Ink style" color={ink.color} selected={formatOpen} onPress={onToggleFormat} />
        <ToolButton label={ink.lifetime === "keep" ? "Kept" : "Fade"} selected={ink.lifetime === "keep"} onPress={() => onInk({ ...ink, lifetime: ink.lifetime === "keep" ? "fade" : "keep" })} />
        <ToolButton label="Undo" icon="undo" onPress={() => onCommand({ kind: "undo" })} />
        <ToolButton label="Redo" icon="redo" onPress={() => onCommand({ kind: "redo" })} />
      </View>
      {formatOpen ? (
        <>
          <View style={styles.row}>{[[assignedColor, "Assigned color"], ...colors].map(([color, label]) => (color && label ? <ToolButton key={label} label={label} color={color} iconOnly selected={ink.color === color} onPress={() => onInk({ ...ink, color })} /> : null))}</View>
          <View style={styles.row}>
            {widths.map(([width, label]) => (
              <ToolButton key={width} label={label} selected={width === ink.width} onPress={() => onInk({ ...ink, width })} />
            ))}
          </View>
        </>
      ) : null}
    </>
  );
}

export function ManageMarks({ state, people, nowMs, onCommand, showPauseAndClear = true }: Pick<ScreenAnnotationToolbarProps, "state" | "onCommand"> & { readonly people: readonly Person[]; readonly nowMs: number; readonly showPauseAndClear?: boolean }) {
  const { access } = state;
  const canModerate = access.can_moderate;
  const canManagePolicy = access.can_manage_policy;
  return (
    <>
      {canModerate && showPauseAndClear ? (
        <View style={styles.row}>
          <ToolButton label={state.paused ? "Resume marks" : "Pause marks"} onPress={() => onCommand({ kind: "pause", paused: !state.paused })} />
          <ToolButton label="Clear all" onPress={() => onCommand({ kind: "clear", scope: { kind: "all" } })} />
        </View>
      ) : null}
      {canManagePolicy ? (
        <View style={styles.row}>
          {(["everyone", "hosts", "picked"] as const).map((policy) => (
            <ToolButton key={policy} label={{ everyone: "Everyone", hosts: "Hosts only", picked: "Picked people" }[policy]} selected={access.draw_policy === policy} onPress={() => onCommand({ kind: "set_policy", policy })} />
          ))}
        </View>
      ) : null}
      {people.map((person) => {
        const request = access.requests.find((value) => value.participant_id === person.id && value.expires_at_ms > nowMs);
        return (
          <View key={person.id} style={styles.person}>
            <ChalkText numberOfLines={1} style={styles.personName}>
              {person.name}
            </ChalkText>
            {canManagePolicy && request ? (
              <>
                <ToolButton label="Allow" accessibilityLabel={`Allow ${person.name} to draw`} onPress={() => onCommand({ kind: "decide_draw", request_id: request.request_id, allow: true })} />
                <ToolButton label="Decline" accessibilityLabel={`Decline request from ${person.name}`} onPress={() => onCommand({ kind: "decide_draw", request_id: request.request_id, allow: false })} />
              </>
            ) : canManagePolicy && !person.manages && access.draw_policy !== "hosts" ? (
              <ToolButton label={person.canDraw ? "Block" : "Allow"} accessibilityLabel={person.canDraw ? `Block ${person.name} from drawing` : `Allow ${person.name} to draw`} onPress={() => onCommand({ kind: "set_draw_permission", participant_id: person.id, allow: !person.canDraw })} />
            ) : null}
            {canModerate ? <ToolButton label="Clear" onPress={() => onCommand({ kind: "clear", scope: { kind: "participant", participant_id: person.id } })} /> : null}
          </View>
        );
      })}
    </>
  );
}

export function ToolButton({
  label,
  accessibilityLabel = label,
  icon,
  path,
  circle,
  glyph,
  color,
  iconOnly,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly icon?: IconName;
  readonly path?: string;
  readonly circle?: true;
  readonly glyph?: string;
  readonly color?: string;
  readonly iconOnly?: boolean;
  readonly selected?: boolean;
  readonly onPress: () => void;
}): React.JSX.Element {
  const { colors: theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: selected ? theme.focus : pressed ? theme.pressed : theme.hover }]}
      testID={`annotation.${label.toLowerCase().replaceAll(" ", "-")}`}
    >
      {icon ? <Icon name={icon} color={selected ? theme.canvas : theme.text} size={19} /> : null}
      {path || circle ? (
        <Svg accessibilityElementsHidden importantForAccessibility="no-hide-descendants" fill="none" height={19} width={19} viewBox="0 0 24 24" stroke={selected ? theme.canvas : theme.text} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}>
          {circle ? <Circle cx={12} cy={12} r={8} /> : <Path d={path} />}
        </Svg>
      ) : null}
      {glyph ? (
        <ChalkText style={styles.glyph} color={selected ? theme.canvas : theme.text}>
          {glyph}
        </ChalkText>
      ) : null}
      {color ? <View style={[styles.swatch, { backgroundColor: color }]} /> : null}
      {!iconOnly ? (
        <ChalkText style={styles.label} numberOfLines={1} adjustsFontSizeToFit color={selected ? theme.canvas : theme.text}>
          {label}
        </ChalkText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tray: { alignSelf: "center", width: "100%", maxWidth: 540, maxHeight: "100%", borderWidth: StyleSheet.hairlineWidth, borderRadius: corners["3xl"], overflow: "hidden" },
  body: { padding: space["2-5"], gap: space["1-5"] },
  row: { flexDirection: "row", alignItems: "stretch", gap: space["1-5"] },
  button: { alignItems: "center", justifyContent: "center", minHeight: 48, flexGrow: 1, flexBasis: 0, paddingHorizontal: space[1], borderRadius: corners["2xl"], gap: space[1] },
  glyph: { fontSize: fontSizes["title-sm"], lineHeight: 23 },
  label: { fontSize: fontSizes.caption, lineHeight: 15 },
  swatch: { width: 18, height: 18, borderRadius: radii.menuRow },
  rule: { height: StyleSheet.hairlineWidth, marginHorizontal: space[1] },
  notice: { alignItems: "center", flexDirection: "row", gap: space[2] },
  person: { flexDirection: "row", alignItems: "center", gap: space["1-5"] },
  personName: { flex: 2 },
});
