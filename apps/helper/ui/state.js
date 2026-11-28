const phasesWithPanel = ["needed", "settings_open"];

/** Which card the Settings window shows. A pure function of the view, so every state has one test. */
export function settingsState(view) {
  if (view.approval) return view.approval.approved ? "confirm" : "pair";
  return view.connected ? connectedState(view) : "waiting";
}

function connectedState(view) {
  if (phasesWithPanel.includes(view.permission?.phase)) return "permission";
  return view.monitors.length > 1 ? "display" : captureState(view);
}

function captureState(view) {
  return view.captureStatus === "ready" ? "live" : "connected";
}

/** The confirmation code reads as four groups of four on screen and one character at a time to a screen reader. */
export function groupedCode(code) {
  return (
    code
      .replaceAll("-", "")
      .match(/.{1,4}/g)
      ?.join("-") ?? ""
  );
}

export function spokenCode(code) {
  return code.replaceAll("-", "").split("").join(" ");
}

export function spaceLabel(view) {
  return view.spaceName || "your call";
}

export function shortcutLabel(platform) {
  return platform.startsWith("Mac") ? "⌘ ⇧ 9" : "Ctrl Shift 9";
}

export function displayShape(monitor) {
  const ratio = monitor.width / monitor.height;
  return ratio >= 1 ? { width: 100, height: Math.round(100 / ratio) } : { width: Math.round(100 * ratio), height: 100 };
}
