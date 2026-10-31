import { cameraBackgroundAvailable, getCameraBackground, loadCameraBackgroundOptions, setCameraBackground, subscribeCameraBackground, type CameraBackground } from "@q9labsai/chalk-client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ChalkMenuItem, ChalkMenuLabel } from "../chalk-ui";

export function CameraBackgroundPicker({ deviceId }: { readonly deviceId: string }) {
  const selected = useSyncExternalStore(
    subscribeCameraBackground,
    () => getCameraBackground(deviceId),
    () => "none",
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [options, setOptions] = useState<Awaited<ReturnType<typeof loadCameraBackgroundOptions>>>([]);
  useEffect(() => {
    let current = true;
    loadCameraBackgroundOptions().then(
      (loaded) => current && setOptions(loaded),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, []);
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
      {options.map((option) => (
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
