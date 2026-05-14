import { File as ExpoFile } from "expo-file-system";
import { GROQ_MODEL, GROQ_REQUEST_TIMEOUT_MS, GROQ_TRANSCRIPTION_URL } from "./constants";

const resolveTranscriptText = (payload: any) => {
  if (typeof payload?.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }

  if (Array.isArray(payload?.segments)) {
    return payload.segments
      .map((segment: any) => (typeof segment?.text === "string" ? segment.text.trim() : ""))
      .filter(Boolean)
      .join(" ");
  }

  return "";
};

export async function transcribeGroqChunk({ apiKey, fileName, fileUri }: { apiKey: string; fileName: string; fileUri: string }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_REQUEST_TIMEOUT_MS);

  try {
    const formData = new FormData();
    formData.append("file", new ExpoFile(fileUri), fileName);
    formData.append("model", GROQ_MODEL);
    formData.append("response_format", "verbose_json");
    formData.append("temperature", "0");

    const response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.error?.message ?? `Groq request failed with status ${response.status}`);
    }

    const text = resolveTranscriptText(payload);

    if (!text) {
      throw new Error("Groq returned an empty transcript for this chunk.");
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}
