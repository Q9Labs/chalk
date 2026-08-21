import ArrowRight02Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight02Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/dist/esm/Cancel01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { CreateSpaceIllustration } from "./HomeIllustrations";

interface CreateSpaceSheetProps {
  readonly isCreating: boolean;
  readonly isOpen: boolean;
  readonly name: string;
  readonly onChangeName: (name: string) => void;
  readonly onClose: () => void;
  readonly onCreate: () => void;
}

export function CreateSpaceSheet({ isCreating, isOpen, name, onChangeName, onClose, onCreate }: CreateSpaceSheetProps): React.JSX.Element {
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={isOpen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.root}>
        <Pressable accessibilityLabel="Close Create Space" onPress={onClose} style={styles.backdrop} />
        <View accessibilityViewIsModal style={styles.sheet}>
          <View style={styles.grip} />
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Create a Space</Text>
              <Text style={styles.subtitle}>A place for the work that keeps moving.</Text>
            </View>
            <Pressable accessibilityLabel="Close" accessibilityRole="button" hitSlop={8} onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
              <HugeiconsIcon color={Theme.colors.ink} icon={Cancel01Icon} size={21} />
            </Pressable>
          </View>
          <View style={styles.illustrationRow}>
            <CreateSpaceIllustration />
            <Text style={styles.illustrationCopy}>Bring people, conversation, and shared work into one calm place.</Text>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>
              Space name <Text style={styles.optional}>Optional</Text>
            </Text>
            <TextInput
              accessibilityLabel="Space name"
              autoCapitalize="sentences"
              autoCorrect
              maxLength={64}
              onChangeText={onChangeName}
              onSubmitEditing={onCreate}
              placeholder="e.g. Product design"
              placeholderTextColor={Theme.colors.placeholder}
              returnKeyType="go"
              style={styles.input}
              value={name}
            />
          </View>
          <Pressable accessibilityRole="button" disabled={isCreating} onPress={onCreate} style={({ pressed }) => [styles.action, pressed && styles.actionPressed, isCreating && styles.disabled]}>
            {isCreating ? (
              <ActivityIndicator color={Theme.colors.primaryForeground} />
            ) : (
              <>
                <Text style={styles.actionText}>Create Space</Text>
                <HugeiconsIcon color={Theme.colors.primaryForeground} icon={ArrowRight02Icon} size={20} />
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(12,14,18,0.24)" },
  sheet: { backgroundColor: Theme.colors.surface, borderColor: Theme.colors.line, borderTopLeftRadius: Theme.radius["2xl"], borderTopRightRadius: Theme.radius["2xl"], borderWidth: 1, paddingBottom: Platform.OS === "ios" ? 34 : 22, paddingHorizontal: Theme.spacing.xl },
  grip: { alignSelf: "center", backgroundColor: Theme.colors.lineStrong, borderRadius: 3, height: 4, marginBottom: Theme.spacing.xl, marginTop: 10, width: 42 },
  header: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between" },
  title: { color: Theme.colors.ink, fontSize: 25, fontWeight: "700", letterSpacing: -0.5 },
  subtitle: { color: Theme.colors.ink2, fontSize: 14, marginTop: 4 },
  close: { alignItems: "center", backgroundColor: Theme.colors.paper2, borderRadius: Theme.radius.full, height: 40, justifyContent: "center", width: 40 },
  illustrationRow: { alignItems: "center", flexDirection: "row", gap: Theme.spacing.lg, marginVertical: Theme.spacing.xl },
  illustrationCopy: { color: Theme.colors.ink2, flex: 1, fontSize: 14, lineHeight: 21 },
  field: { gap: Theme.spacing.sm },
  label: { color: Theme.colors.ink, fontSize: 14, fontWeight: "600" },
  optional: { color: Theme.colors.ink3, fontWeight: "500" },
  input: { backgroundColor: Theme.colors.surfaceMuted, borderColor: Theme.colors.lineStrong, borderRadius: Theme.radius.md, borderWidth: 1, color: Theme.colors.ink, fontSize: 16, minHeight: 54, paddingHorizontal: Theme.spacing.lg },
  action: { alignItems: "center", backgroundColor: Theme.colors.ink, borderRadius: Theme.radius.md, flexDirection: "row", gap: Theme.spacing.sm, justifyContent: "center", marginTop: Theme.spacing.lg, minHeight: 54 },
  actionText: { color: Theme.colors.primaryForeground, fontSize: 16, fontWeight: "700" },
  actionPressed: { opacity: 0.84, transform: [{ scale: 0.99 }] },
  pressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
  disabled: { opacity: 0.5 },
});
