import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChalkChatAttachment, type ChalkSessionStore } from "@q9labsai/chalk-client";
import { uploadChatAttachment } from "@q9labsai/chalk-react-native";
import { CryptoDigestAlgorithm, digest, randomUUID } from "expo-crypto";
import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";

type ChatFiles = NonNullable<ChalkSessionStore["chatFiles"]>;

export async function pickAndUploadChatAttachments(chatFiles: ChatFiles): Promise<readonly ChalkChatAttachment[]> {
  const result = await getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
    type: [...CHALK_CHAT_ATTACHMENT_MIME_TYPES],
  });
  if (result.canceled) return [];
  if (result.assets.length > CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) {
    throw new Error(`Choose at most ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files.`);
  }

  const attachments: ChalkChatAttachment[] = [];
  for (const asset of result.assets) {
    const file = new File(asset.uri);
    const bytes = await file.arrayBuffer();
    attachments.push(
      await uploadChatAttachment(
        {
          bytes,
          fileName: asset.name,
          mimeType: asset.mimeType || file.type,
        },
        chatFiles,
        {
          digestSha256: sha256,
          randomUUID,
        },
      ),
    );
  }
  return attachments;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const hashed = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes));
  return Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
