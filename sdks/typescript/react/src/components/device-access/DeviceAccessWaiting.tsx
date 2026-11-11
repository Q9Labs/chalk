import { useEffect, useState } from "react";
import { DeviceAccessStyles } from "./DeviceAccessStyles";
import { browserPorts, watchPermission } from "./resolve";

/** A device is being requested. When the browser has not decided yet, its own prompt is open: the page dims and one pill points at the prompt. */
export function DeviceAccessWaiting({ device }: { readonly device: "microphone" | "camera" }) {
  const [prompting, setPrompting] = useState(false);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [external-subscription] The browser permission answer changes when the person picks Allow or Block.
  useEffect(() => watchPermission(browserPorts(), device, (answer) => setPrompting(answer === "prompt")), [device]);
  if (!prompting) return null;
  return (
    <>
      <DeviceAccessStyles />
      <div className="chalk-access-dim" aria-hidden="true" />
      <div className="chalk-access-coach" data-part="access-waiting" role="status">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 19V5M6 11l6-6 6 6" />
        </svg>
        Choose Allow above
      </div>
    </>
  );
}
