import type { ConnectionSlice, MediaSlice } from "@q9labsai/chalk-client";

export function callDiagnostics(connection: ConnectionSlice, media: MediaSlice) {
  const rows = [{ label: "Connection", value: connection.status === "live" ? "Connected" : "Reconnecting" }];
  const camera = media.local.camera.track?.getSettings();
  const microphone = media.local.microphone.track?.getSettings();
  if (camera?.width && camera.height) rows.push({ label: "Video", value: `${camera.width} × ${camera.height}${camera.frameRate ? ` · ${Math.round(camera.frameRate)} fps` : ""}` });
  if (microphone?.sampleRate) rows.push({ label: "Audio", value: `${(microphone.sampleRate / 1000).toLocaleString()} kHz` });
  for (const [label, devices, selected] of [
    ["Microphone", media.devices.microphones, media.selection.microphone],
    ["Speaker", media.devices.speakers, media.selection.speaker],
    ["Camera", media.devices.cameras, media.selection.camera],
  ] as const) {
    const device = devices.find((item) => item.deviceId === selected);
    if (device?.label) rows.push({ label, value: device.label });
  }
  if (media.screenShare.capture?.label) rows.push({ label: "Sharing", value: media.screenShare.capture.label });
  return rows;
}
