import { fontFamilies, useTheme } from "@q9labsai/chalk-react-native/ui";
import { forwardRef, useState } from "react";
import { StyleSheet, TextInput, type TextInputProps } from "react-native";

type TextFieldProps = Omit<TextInputProps, "style"> & {
  /** `sheet` is the 48 pt sheet field (`.tin`); `card` is the 44 pt name card field (`.lcard input`). */
  readonly size: "sheet" | "card";
  readonly invalid?: boolean;
};

/** A text field on a raised surface. Its border turns to the text colour while focused and red when invalid. */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField({ size, invalid = false, onFocus, onBlur, ...rest }, ref) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = invalid ? colors.dangerText : focused ? colors.text : colors.lineStrong;
  return (
    <TextInput
      {...rest}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      placeholderTextColor={colors.textMuted}
      ref={ref}
      selectionColor={colors.text}
      style={[styles.field, size === "sheet" ? styles.sheet : styles.card, { backgroundColor: colors.raised, borderColor, color: colors.text }]}
    />
  );
});

const styles = StyleSheet.create({
  field: { paddingHorizontal: 14, borderWidth: 1, fontFamily: fontFamilies[400], fontSize: 16 },
  sheet: { flex: 1, height: 48, borderRadius: 12 },
  card: { height: 44, borderRadius: 10, fontSize: 14 },
});
