import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";

export async function shareAnnotationPng(base64: string): Promise<void> {
  if (!(await isAvailableAsync())) throw new Error("Image sharing is unavailable on this device");
  const file = new File(Paths.cache, `chalk-marked-frame-${randomUUID()}.png`);
  try {
    file.write(base64, { encoding: "base64" });
    await shareAsync(file.uri, { mimeType: "image/png", UTI: "public.png", dialogTitle: "Save or share the marked frame", anchor: { x: 16, y: 16, width: 1, height: 1 } });
  } finally {
    if (file.exists) file.delete();
  }
}
