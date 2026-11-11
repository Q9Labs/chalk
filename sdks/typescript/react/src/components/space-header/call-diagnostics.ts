import { currentSessionId, type ConnectionSlice, type MediaSlice } from "@q9labsai/chalk-client";

/** Facts for the call menu and for problem reports. The Connection row stays first: the menu reads quality from `network` and skips it. */
export function callDiagnostics(connection: ConnectionSlice, media: MediaSlice) {
  const rows = [{ label: "Connection", value: connection.status === "live" ? "Connected" : "Reconnecting" }];
  const camera = media.local.camera.track?.getSettings();
  const microphone = media.local.microphone.track?.getSettings();
  const video = camera?.width && camera.height ? [`${camera.width} × ${camera.height}`, ...(camera.frameRate ? [`${Math.round(camera.frameRate)} fps`] : [])] : [];
  const audio = microphone?.sampleRate ? [`${(microphone.sampleRate / 1000).toLocaleString()} kHz`] : [];
  for (const [label, devices, selected, settings] of [
    ["Microphone", media.devices.microphones, media.selection.microphone, audio],
    ["Speaker", media.devices.speakers, media.selection.speaker, []],
    ["Camera", media.devices.cameras, media.selection.camera, video],
  ] as const) {
    const device = devices.find((item) => item.deviceId === selected);
    const value = [device?.label, ...settings].filter(Boolean).join(" · ");
    if (value) rows.push({ label, value });
  }
  if (media.screenShare.capture?.label) rows.push({ label: "Sharing", value: media.screenShare.capture.label });
  const session = currentSessionId();
  if (session) rows.push({ label: "Session", value: session });
  return rows;
}
