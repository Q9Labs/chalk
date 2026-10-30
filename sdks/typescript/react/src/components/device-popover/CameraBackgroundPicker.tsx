import { CAMERA_BACKGROUND_OPTIONS, cameraBackgroundAvailable, getCameraBackground, setCameraBackground, subscribeCameraBackground, type CameraBackground } from "@q9labsai/chalk-client";
import { useState, useSyncExternalStore } from "react";
import { ChalkMenuItem, ChalkMenuLabel } from "../chalk-ui";

export function CameraBackgroundPicker({ deviceId }: { readonly deviceId: string }) {
  const selected = useSyncExternalStore(
    subscribeCameraBackground,
    () => getCameraBackground(deviceId),
    () => "none",
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!cameraBackgroundAvailable(deviceId)) return null;
  const select = async (background: CameraBackground) => {
    setBusy(true);
    setFailed(false);
    try {
      await setCameraBackground(deviceId, background);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ChalkMenuLabel>Background</ChalkMenuLabel>
      {CAMERA_BACKGROUND_OPTIONS.map((option) => (
        <ChalkMenuItem
          key={option.id}
          checked={selected === option.id}
          disabled={busy}
          closeOnClick={false}
          onClick={() => {
            void select(option.id);
          }}
        >
          {option.image ? (
            <picture>
              <source srcSet={option.avif} type="image/avif" />
              <img src={option.image} alt="" width={40} height={24} style={{ objectFit: "cover", borderRadius: 4 }} />
            </picture>
          ) : null}
          {option.label}
        </ChalkMenuItem>
      ))}
      {busy ? <span role="status">Loading background…</span> : null}
      {failed ? <span role="alert">Background didn’t load. Try again.</span> : null}
    </>
  );
}
