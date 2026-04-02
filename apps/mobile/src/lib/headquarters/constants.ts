import type { AudioQuality, IOSOutputFormat, RecordingOptions } from "expo-audio";
import { ExpoAudioQuality, ExpoIOSOutputFormat } from "./expo-audio-safe";

export const APP_STORAGE_KEY = "hasan-headquaters:v1:recordings";
export const GROQ_API_KEY_STORAGE_KEY = "hasan-headquaters:v1:groq-api-key";
export const RECORDING_CHUNK_SECONDS = 9 * 60;
export const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_MODEL = "whisper-large-v3";
export const GROQ_REQUEST_TIMEOUT_MS = 180_000;
export const MAX_TRANSCRIPTION_ATTEMPTS = 4;

export const RECORDING_OPTIONS: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  isMeteringEnabled: true,
  android: {
    extension: ".m4a",
    sampleRate: 16_000,
    outputFormat: "mpeg4",
    audioEncoder: "aac",
    maxFileSize: 8 * 1024 * 1024,
  },
  ios: {
    extension: ".m4a",
    sampleRate: 16_000,
    outputFormat: ExpoIOSOutputFormat.MPEG4AAC as IOSOutputFormat,
    audioQuality: ExpoAudioQuality.LOW as AudioQuality,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/mp4",
    bitsPerSecond: 32_000,
  },
};
