import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export async function writeDashboardArtifacts(runtimeRoot, artifacts) {
  const root = resolve(runtimeRoot, "dashboard-artifacts", "__local-dashboard-artifacts");
  for (const [key, value] of Object.entries(artifacts)) {
    const path = resolve(root, `.${key}`);
    if (!key.startsWith("/") || !path.startsWith(`${root}${sep}`)) throw new Error(`Invalid local artifact key: ${key}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value === "preview-audio" ? previewAudio() : JSON.stringify(value));
  }
}

// A short, synthetic recording keeps playback reviewable without a media vendor.
export function previewAudio() {
  const samples = 12000 * 8;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) wav.writeInt16LE(Math.round(Math.sin((sample * 2 * Math.PI * 220) / 8000) * 1000), 44 + sample * 2);
  return wav;
}
