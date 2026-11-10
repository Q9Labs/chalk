import { DeviceAccessStyles } from "./DeviceAccessStyles";

/** The browser's own prompt is open. The page dims and one pill points at the prompt. */
export function DeviceAccessWaiting() {
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
