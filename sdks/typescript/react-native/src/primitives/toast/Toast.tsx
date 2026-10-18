import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMeasuredRef } from "../../frame/measurement";
import { useTheme } from "../../theme/theme";
import { fontFamilies } from "../../theme/tokens";
import { ChalkText } from "../ChalkText";
import { IconButton } from "../IconButton";
import { PillButton } from "../PillButton";
import type { Toast as ToastModel } from "./toast-store";

export type ToastProps = {
  readonly toast: ToastModel;
  readonly onDismiss: () => void;
};

/** One event notice (`.toast`). Every notice in the call uses this look. */
export const Toast = memo(function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const { colors, elevation } = useTheme();
  const parts = typeof toast.message === "string" ? [toast.message] : toast.message;
  const testID = toast.testID ?? `toast.${toast.id}`;
  const toastStyle = [styles.toast, { backgroundColor: colors.popover, borderColor: colors.line, boxShadow: elevation.toast }];
  const ref = useMeasuredRef<View>(testID, toastStyle);
  return (
    <View accessibilityLiveRegion={toast.kind === "error" ? "assertive" : "polite"} accessibilityRole={toast.kind === "error" ? "alert" : "summary"} ref={ref} style={toastStyle} testID={testID}>
      {toast.leading}
      <ChalkText numberOfLines={toast.wrap ? undefined : 1} style={[styles.message, toast.wrap ? styles.wrapped : null]}>
        {parts.map((part, index) =>
          typeof part === "string" ? (
            part
          ) : (
            <Text key={index} style={styles.strong}>
              {part.strong}
            </Text>
          ),
        )}
      </ChalkText>
      {toast.actions?.map((action) => (
        <PillButton key={action.label} label={action.label} onPress={action.onPress} testID={action.testID} variant={action.variant ?? "secondary"} />
      ))}
      {toast.dismissible ? <IconButton accessibilityLabel="Dismiss" icon="x" onPress={onDismiss} size={36} tone="ghost" /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  toast: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingVertical: 6, paddingRight: 6, paddingLeft: 14, borderWidth: 1, borderRadius: 12 },
  message: { flexShrink: 1, marginRight: 4 },
  wrapped: { lineHeight: 14 * 1.35, paddingVertical: 4 },
  strong: { fontFamily: fontFamilies[600] },
});
