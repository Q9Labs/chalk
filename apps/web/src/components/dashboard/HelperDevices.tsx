import { useState } from "react";
import { listHelperDevices, manageHelperDevice } from "../../lib/dashboard/helper-devices";
import { DisconnectPrompt } from "./DisconnectPrompt";
import { ErrorPanel, SkeletonRows, useToast } from "./kit";
import { useLoad } from "./use-dashboard";

type Device = Awaited<ReturnType<typeof listHelperDevices>>[number];

function Devices() {
  const { state, reload, update } = useLoad(() => listHelperDevices(), "helper-devices");
  const [device, setDevice] = useState<Device | null>(null);
  const toast = useToast();

  return (
    <>
      {state.kind === "loading" ? <SkeletonRows count={2} /> : null}
      {state.kind === "error" ? <ErrorPanel title="Couldn’t load Chalk Helper devices" detail="Try loading your registered devices again." onRetry={reload} /> : null}
      {state.kind === "ready" && state.data.length === 0 ? <p>No devices registered.</p> : null}
      {state.kind === "ready" && state.data.length > 0 ? (
        <ul>
          {state.data.map((row) => (
            <li key={row.deviceId} className="flex items-center justify-between gap-4 p-2">
              <bdi>{row.name}</bdi>
              <button type="button" className="btn" onClick={() => setDevice(row)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {device ? (
        <DisconnectPrompt
          app={device.name}
          onCancel={() => setDevice(null)}
          onConfirm={() =>
            manageHelperDevice({ action: "revoke", deviceId: device.deviceId }).then(
              () => {
                update((devices) => devices.filter((row) => row.deviceId !== device.deviceId));
                setDevice(null);
                toast("Chalk Helper access revoked", { icon: "trash" });
              },
              () => toast("Couldn’t revoke Chalk Helper access", { icon: "alert" }),
            )
          }
        />
      ) : null}
    </>
  );
}

export function HelperDevices() {
  const [open, setOpen] = useState(false);
  if (!import.meta.env.VITE_CHALK_HELPER_INSTALL_URL) return null;
  return (
    <section>
      <div className="secth" style={{ marginTop: "var(--space-12)" }}>
        <h2>Chalk Helper devices</h2>
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide devices" : "Manage devices"}
        </button>
      </div>
      {open ? <Devices /> : null}
    </section>
  );
}
