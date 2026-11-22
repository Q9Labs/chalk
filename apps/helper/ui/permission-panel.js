export const permissionMarkup = `<div class="permission" hidden>
      <h2 id="permission-title"></h2>
      <p id="permission-body"></p>
      <p id="permission-wait" role="status" hidden>Waiting for you. This updates on its own.</p>
      <div class="actions">
        <button type="button" class="primary" id="permission-primary"></button>
        <button type="button" class="quiet" id="permission-later">Not now</button>
      </div>
      <button type="button" class="link" id="permission-finder">Show Chalk Helper in Finder</button>
    </div>`;

const permissionCopy = {
  needed: {
    title: "Allow Screen Recording",
    body: "Chalk Helper needs it to keep marks on the window you share. Without it, marks still show in the call preview.",
    primary: ["Open System Settings", "open_screen_recording_settings"],
    later: true,
  },
  settings_open: {
    title: "Add Chalk Helper",
    body: "Drag the Chalk Helper tile into the Screen Recording list, or switch it on if it’s already there. If macOS offers to quit Chalk Helper, choose Later.",
    primary: ["Open System Settings", "open_screen_recording_settings"],
    later: true,
    waiting: true,
    finder: true,
  },
  later: {
    title: "Window follow is off",
    body: "Marks still show in the call preview.",
    primary: ["Turn on window follow", "follow_window"],
  },
};

export function paintPermission(root, view) {
  const copy = view.approval ? undefined : permissionCopy[view.permission?.phase];
  root.querySelector(".permission").hidden = !copy;
  root.querySelector("#follow-window").hidden = !view.canFollowWindow || Boolean(copy);
  if (!copy) return;
  root.querySelector("#permission-title").textContent = copy.title;
  root.querySelector("#permission-body").textContent = copy.body;
  root.querySelector("#permission-wait").hidden = !copy.waiting;
  const primary = root.querySelector("#permission-primary");
  primary.textContent = copy.primary[0];
  primary.dataset.action = copy.primary[1];
  root.querySelector("#permission-later").hidden = !copy.later;
  root.querySelector("#permission-finder").hidden = !copy.finder;
}
