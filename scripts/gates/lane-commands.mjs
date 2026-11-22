import { isWindows } from "../lib/platform.mjs";

export function* laneCommands(task, windows = isWindows) {
  if (!windows || task.id !== "format") {
    yield task.command;
    return;
  }

  const prefix = task.command.slice(0, 4); // pnpm exec oxfmt --check
  let command = [...prefix];
  let pathLength = 0;
  // Leave room under cmd.exe's 8191-character limit for the nested pnpm and formatter shims.
  for (const file of task.command.slice(prefix.length)) {
    const argumentLength = file.length + 3; // Space and quotes around the path.
    if (pathLength > 0 && pathLength + argumentLength > 2000) {
      yield command;
      command = [...prefix];
      pathLength = 0;
    }
    command.push(file);
    pathLength += argumentLength;
  }
  yield command;
}
