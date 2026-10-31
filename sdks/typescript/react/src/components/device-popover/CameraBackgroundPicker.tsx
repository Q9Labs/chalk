import { loadCameraBackgroundControls, setCameraBackground, subscribeCameraBackground, type CameraBackground } from "@q9labsai/chalk-client";
import { useEffect, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

type Controls = Awaited<ReturnType<typeof loadCameraBackgroundControls>>;
type MenuItemProps = { readonly checked: boolean; readonly disabled: boolean; readonly closeOnClick: boolean; readonly onClick: () => void; readonly children: ReactNode };

/** The menu parts are passed in so this lazy chunk shares no UI module with the call controls. */
export interface CameraBackgroundMenu {
  readonly Label: ComponentType<{ readonly children: ReactNode }>;
  readonly Item: ComponentType<MenuItemProps>;
}

export function CameraBackgroundPicker({ deviceId, menu }: { readonly deviceId: string; readonly menu: CameraBackgroundMenu }) {
  const [controls, setControls] = useState<Controls>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void loadCameraBackgroundControls().then(
      (loaded) => {
        if (active) setControls(loaded);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (failed) return <span role="alert">Backgrounds didn’t load. Reopen to try again.</span>;
  return controls ? <Options controls={controls} deviceId={deviceId} menu={menu} /> : null;
}

function Options({ controls, deviceId, menu: { Label, Item } }: { readonly controls: Controls; readonly deviceId: string; readonly menu: CameraBackgroundMenu }) {
  const selected = useSyncExternalStore(
    subscribeCameraBackground,
    () => controls.getCameraBackground(deviceId),
    () => "none",
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!controls.cameraBackgroundAvailable(deviceId)) return null;
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
      <Label>Background</Label>
      {controls.CAMERA_BACKGROUND_OPTIONS.map((option) => (
        <Item
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
        </Item>
      ))}
      {busy ? <span role="status">Loading background…</span> : null}
      {failed ? <span role="alert">Background didn’t load. Try again.</span> : null}
    </>
  );
}
