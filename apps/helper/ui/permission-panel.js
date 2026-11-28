function stepState(number, current) {
  if (number < current) return "done";
  return number === current ? "now" : "todo";
}

export function paintPermission(root, permission) {
  const open = permission?.phase === "settings_open";
  root.querySelector("#permission-wait").hidden = !open;
  root.querySelector("#permission-finder").hidden = !open;
  root.querySelectorAll("[data-step]").forEach((step) => {
    const number = Number(step.dataset.step);
    const current = open ? 2 : 1;
    step.dataset.state = stepState(number, current);
    step.querySelector(".n").textContent = number < current ? "✓" : String(number);
    step.setAttribute("aria-current", number === current ? "step" : "false");
  });
}
