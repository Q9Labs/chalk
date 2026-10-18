import { forwardRef } from "react";
import { StyleSheet, TextInput, type TextInputProps } from "react-native";
import { useTheme } from "../../theme/theme";
import { type } from "../../theme/tokens";

/** The text input inside a field (`input` in the mockup): the body type, no chrome of its own. */
export const TextField = forwardRef<TextInput, TextInputProps>(function TextField({ style, ...rest }, ref) {
  const { colors } = useTheme();
  return <TextInput {...rest} cursorColor={colors.text} placeholderTextColor={colors.textMuted} ref={ref} selectionColor={colors.textMuted} style={[styles.input, { color: colors.text }, style]} />;
});

const styles = StyleSheet.create({
  input: { flex: 1, minWidth: 0, height: "100%", padding: 0, fontFamily: type.body.fontFamily, fontSize: type.body.fontSize },
});
