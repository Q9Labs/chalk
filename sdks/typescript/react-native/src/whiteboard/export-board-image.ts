import { setImageAsync } from "expo-clipboard";
import { File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";

/** Native exports stay on the device and use the system’s save/share destinations. */
export async function exportBoardImage(value: { readonly format: "png" | "svg"; readonly dataURL: string; readonly action?: "download" | "copy" }): Promise<void> {
  if (value.format !== "png" || !value.dataURL.startsWith("data:image/png;base64,")) throw new Error("Board export is not a PNG image");
  const base64 = value.dataURL.slice("data:image/png;base64,".length);
  if (value.action === "copy") {
    await setImageAsync(base64);
    return;
  }
  if (!(await isAvailableAsync())) throw new Error("Image sharing is unavailable on this device");
  const file = new File(Paths.cache, `chalk-board-${Date.now()}.png`);
  try {
    file.write(base64, { encoding: "base64" });
    await shareAsync(file.uri, { mimeType: "image/png", UTI: "public.png", dialogTitle: "Save or share the board", anchor: { x: 16, y: 16, width: 1, height: 1 } });
  } finally {
    if (file.exists) file.delete();
  }
}
