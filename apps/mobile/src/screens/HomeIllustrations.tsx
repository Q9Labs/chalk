import { StyleSheet, View } from "react-native";

import { Theme } from "@q9labsai/chalk-react-native/theme";

export function CreateSpaceIllustration(): React.JSX.Element {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.createScene}>
      <View style={[styles.paper, styles.paperBack]} />
      <View style={[styles.paper, styles.paperFront]}>
        <View style={[styles.line, styles.lineLong]} />
        <View style={[styles.line, styles.lineShort]} />
        <View style={styles.peopleRow}>
          <View style={[styles.person, styles.green]} />
          <View style={[styles.person, styles.yellow]} />
          <View style={[styles.person, styles.blue]} />
        </View>
      </View>
      <View style={styles.pencil} />
      <View style={styles.spark} />
    </View>
  );
}

export function SpaceHistoryIllustration(): React.JSX.Element {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.historyScene}>
      <View style={[styles.orbit, styles.orbitOuter]} />
      <View style={[styles.orbit, styles.orbitInner]} />
      <View style={[styles.historyPaper, styles.historyPaperBack]} />
      <View style={styles.historyPaper}>
        <View style={[styles.line, styles.historyLine]} />
        <View style={[styles.line, styles.historyLineShort]} />
        <View style={styles.historyDotRow}>
          <View style={[styles.historyDot, styles.pink]} />
          <View style={[styles.historyDot, styles.blue]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  createScene: { height: 116, position: "relative", width: 126 },
  paper: { backgroundColor: Theme.colors.surface, borderColor: Theme.colors.line, borderRadius: 10, borderWidth: 1, height: 82, left: 18, padding: 13, position: "absolute", top: 18, width: 88 },
  paperBack: { backgroundColor: Theme.colors.washYellow, left: 26, top: 10, transform: [{ rotate: "7deg" }] },
  paperFront: { transform: [{ rotate: "-3deg" }] },
  line: { backgroundColor: Theme.colors.ink, borderRadius: 3, height: 5 },
  lineLong: { width: 51 },
  lineShort: { backgroundColor: Theme.colors.ink3, marginTop: 7, width: 35 },
  peopleRow: { bottom: 12, flexDirection: "row", gap: 5, position: "absolute", right: 11 },
  person: { borderColor: Theme.colors.surface, borderRadius: 9, borderWidth: 2, height: 18, width: 18 },
  green: { backgroundColor: Theme.colors.chalkGreen },
  yellow: { backgroundColor: Theme.colors.chalkYellow },
  blue: { backgroundColor: Theme.colors.chalkBlue },
  pink: { backgroundColor: Theme.colors.chalkPink },
  pencil: { backgroundColor: Theme.colors.chalkPink, borderRadius: 4, bottom: 11, height: 9, position: "absolute", right: 2, transform: [{ rotate: "-43deg" }], width: 43 },
  spark: { borderColor: Theme.colors.chalkBlue, borderRadius: 8, borderWidth: 2, height: 13, left: 5, position: "absolute", top: 8, transform: [{ rotate: "22deg" }], width: 13 },
  historyScene: { height: 112, position: "relative", width: 148 },
  orbit: { borderColor: Theme.colors.line, borderRadius: 80, borderWidth: 1, position: "absolute" },
  orbitOuter: { height: 104, left: 22, top: 4, width: 104 },
  orbitInner: { borderColor: Theme.colors.washBlue, height: 76, left: 36, top: 18, width: 76 },
  historyPaper: { backgroundColor: Theme.colors.surface, borderColor: Theme.colors.line, borderRadius: 9, borderWidth: 1, height: 68, left: 42, padding: 12, position: "absolute", top: 23, transform: [{ rotate: "-4deg" }], width: 70 },
  historyPaperBack: { backgroundColor: Theme.colors.washGreen, left: 48, top: 18, transform: [{ rotate: "6deg" }] },
  historyLine: { width: 40 },
  historyLineShort: { backgroundColor: Theme.colors.ink3, marginTop: 7, width: 27 },
  historyDotRow: { bottom: 9, flexDirection: "row", gap: 5, position: "absolute", right: 9 },
  historyDot: { borderRadius: 6, height: 12, width: 12 },
});
