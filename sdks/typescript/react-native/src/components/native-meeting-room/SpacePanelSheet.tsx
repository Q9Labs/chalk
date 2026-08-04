import { Modal, Pressable, SafeAreaView, StyleSheet, View } from "react-native";

import { Theme } from "../../ui/theme";
import { SpaceChatSheet } from "./SpaceChatSheet";
import { SpacePeopleSheet } from "./SpacePeopleSheet";
import { SheetGrip, SurfaceHeader } from "./SpaceSurfacePrimitives";
import type { SpaceController } from "./space-progressive-surface-types";

export function SpacePanelSheet({ controller }: { readonly controller: SpaceController }): React.JSX.Element {
  const visible = controller.panel !== null;
  const close = controller.closePanel;
  const isChat = controller.panel === "chat";
  return (
    <Modal animationType="slide" onRequestClose={close} transparent visible={visible}>
      <View style={styles.modalRoot}>
        <Pressable accessibilityLabel="Close panel" onPress={close} style={styles.backdrop} />
        <SafeAreaView style={styles.sheet}>
          <SheetGrip />
          <SurfaceHeader closeLabel={`Close ${isChat ? "Chat" : "People"}`} count={!isChat ? controller.participantCount : undefined} onClose={close} title={isChat ? "Chat" : "People"} />
          {isChat ? <SpaceChatSheet controller={controller} /> : <SpacePeopleSheet controller={controller} />}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { backgroundColor: "rgba(12,14,18,0.22)", bottom: 94, left: 0, position: "absolute", right: 0, top: 0 },
  sheet: {
    backgroundColor: Theme.colors.surface,
    borderColor: Theme.colors.line,
    borderTopLeftRadius: Theme.radius.xl,
    borderTopRightRadius: Theme.radius.xl,
    elevation: 8,
    flex: 1,
    marginBottom: 94,
    marginTop: 78,
    overflow: "hidden",
    shadowColor: Theme.colors.ink,
    shadowOffset: { height: -8, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 22,
  },
});
