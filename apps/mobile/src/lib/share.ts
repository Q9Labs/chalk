import { Platform, Share } from "react-native";

/** Opens the system share sheet for a call link. iOS shares it as a URL, so apps unfold its preview. */
export function shareLink(link: string): void {
  void Share.share(Platform.OS === "ios" ? { url: link } : { message: link }).catch(() => undefined);
}
