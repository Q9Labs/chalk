import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatUploadFile } from "@q9labsai/chalk-client";
import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";

/**
 * Selects files for the native Space composer. The RN package owns staging,
 * removal, upload, and send; this adapter only translates Expo's picker
 * result into the canonical lazy file contract.
 */
export async function pickMobileChatFiles(): Promise<readonly ChatUploadFile[]> {
  const result = await getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
    type: [...CHALK_CHAT_ATTACHMENT_MIME_TYPES],
  });
  if (result.canceled) return [];
  if (result.assets.length > CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) {
    throw new Error(`Choose at most ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files.`);
  }

  return result.assets.map((asset) => {
    const file = new File(asset.uri);
    return {
      name: asset.name,
      type: asset.mimeType || file.type,
      size: asset.size ?? file.size,
      arrayBuffer: () => file.arrayBuffer(),
    };
  });
}
