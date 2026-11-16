// Windows and POSIX differences that the repository's Node scripts share: starting a command, importing a file by
// path, and stopping a process with its children.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const isWindows = process.platform === "win32";

/**
 * Finds what a bare command name runs. On Windows a tool such as `pnpm` is a `pnpm.cmd` shim that spawn cannot start
 * by name, so this searches PATH with PATHEXT the way cmd.exe does. A name with a directory is checked as given.
 * Returns undefined when nothing matches.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function findExecutable(command, env = process.env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const directories = command.includes("/") || command.includes("\\") ? [""] : (env[pathKey] ?? "").split(path.delimiter).filter(Boolean);
  // `pnpm` also names an extensionless shell script on Windows, which cmd.exe cannot run, so a bare name only matches PATHEXT.
  const extensions = isWindows && !path.extname(command) ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}

const cmdShim = /\.(?:cmd|bat)$/i;

/**
 * Turns a command and its arguments into what child_process needs on this platform. On Windows a `.cmd` or `.bat`
 * target runs through `cmd.exe /d /s /c` with every argument double-quoted, which keeps `& | < > ^ ( )` literal. An
 * argument that holds `"`, `%` or a line break cannot be quoted safely for cmd.exe, so it throws instead of guessing.
 * Elsewhere, and for a real `.exe`, the command runs as given, with no shell.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ file: string, args: string[], windowsVerbatimArguments?: true }}
 */
export function resolveCommand(command, args, options = {}) {
  if (!isWindows) return { file: command, args: [...args] };
  const executable = findExecutable(command, options.env) ?? command;
  if (!cmdShim.test(executable)) return { file: executable, args: [...args] };
  for (const argument of args) {
    if (/["%\r\n]/.test(argument)) throw new Error(`Cannot pass ${JSON.stringify(argument)} to ${command} on Windows: cmd.exe cannot quote it safely`);
  }
  const line = [executable, ...args].map((part) => `"${part}"`).join(" ");
  return { file: options.env?.ComSpec ?? process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * `child_process.spawn` that also starts `.cmd` shims on Windows.
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {import("node:child_process").SpawnOptions} [options]
 */
export function spawnCommand(command, args = [], options = {}) {
  const resolved = resolveCommand(command, args, options);
  return spawn(resolved.file, resolved.args, { ...options, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
}

/**
 * `child_process.spawnSync` that also starts `.cmd` shims on Windows.
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 */
export function spawnCommandSync(command, args = [], options = {}) {
  const resolved = resolveCommand(command, args, options);
  return spawnSync(resolved.file, resolved.args, { ...options, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
}

/**
 * `child_process.execFileSync` that also starts `.cmd` shims on Windows.
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
export function execCommandSync(command, args = [], options = {}) {
  const resolved = resolveCommand(command, args, options);
  return execFileSync(resolved.file, resolved.args, { ...options, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
}

/**
 * The promise form of `execFile` that also starts `.cmd` shims on Windows.
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {import("node:child_process").ExecFileOptions} [options]
 */
export function execCommand(command, args = [], options = {}) {
  const resolved = resolveCommand(command, args, options);
  return promisify(execFile)(resolved.file, resolved.args, { ...options, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
}

/**
 * Runs a command with the terminal attached and returns its exit status (1 when a signal ended it). A command that
 * cannot start throws with its name, so the caller sees which tool is missing.
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 * @returns {number}
 */
export function runCommand(command, args = [], options = {}) {
  const result = spawnCommandSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`Cannot start ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

/**
 * Imports a module by file system path. `import("D:\\a\\x.mjs")` fails on Windows because the drive letter reads as a
 * URL scheme, so the path becomes a file URL first. A `file:` URL string passes through unchanged.
 * @param {string} modulePath
 */
export function importPath(modulePath) {
  return import(modulePath.startsWith("file:") ? modulePath : pathToFileURL(path.resolve(modulePath)).href);
}

/**
 * Stops a child and everything it started. On Windows this is `taskkill /T /F`; elsewhere it signals the child's
 * process group, so spawn the child with `detached: true` there. Does nothing when the child already exited.
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} [signal]
 */
export function killTree(child, signal = "SIGTERM") {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
