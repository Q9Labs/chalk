// Windows and POSIX differences that the repository's Node scripts share: starting a command and stopping a process
// with its children.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const isWindows = process.platform === "win32";

const isFile = (candidate) => existsSync(candidate) && statSync(candidate).isFile();

/** The directories a command name is looked up in: only the name's own when it already has a directory. */
function searchDirectories(command, environment) {
  if (path.basename(command) !== command) return [""];
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  return (environment[pathKey] ?? "").split(path.delimiter).filter(Boolean);
}

/** The file names a command can have. `pnpm` also names an extensionless shell script on Windows, which cmd.exe cannot run, so a bare name only matches PATHEXT there. */
function candidateNames(command, environment) {
  if (!isWindows || path.extname(command)) return [command];
  return (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => command + extension);
}

/**
 * Finds what a bare command name runs. On Windows a tool such as `pnpm` is a `pnpm.cmd` shim that spawn cannot start
 * by name, so this searches PATH with PATHEXT the way cmd.exe does. A name with a directory is checked as given.
 * Returns undefined when nothing matches.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string | undefined}
 */
export function findExecutable(command, environment = process.env) {
  const names = candidateNames(command, environment);
  for (const directory of searchDirectories(command, environment)) {
    const found = names.map((name) => path.join(directory, name)).find(isFile);
    if (found) return found;
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
  if (!isWindows) return asGiven(command, args);
  const executable = findExecutable(command, options.env) ?? command;
  return cmdShim.test(executable) ? throughCmd(executable, command, args, options.env) : asGiven(executable, args);
}

const asGiven = (file, args) => ({ file, args: [...args] });

function throughCmd(executable, command, args, environment) {
  assertQuotable(command, args);
  const line = [executable, ...args].map((part) => `"${part}"`).join(" ");
  return { file: environment?.ComSpec ?? process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

function assertQuotable(command, args) {
  const unsafe = args.find((argument) => /["%\r\n]/.test(argument));
  if (unsafe !== undefined) throw new Error(`Cannot pass ${JSON.stringify(unsafe)} to ${command} on Windows: cmd.exe cannot quote it safely`);
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
 * Stops a child and everything it started. On Windows this is `taskkill /T /F`; elsewhere it signals the child's
 * process group, so spawn the child with `detached: true` there. Does nothing when the child already exited.
 * The dev-container scripts (scripts/dev/process.mjs) call it.
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} [signal]
 */
export function killTree(child, signal = "SIGTERM") {
  if (!isRunning(child)) return;
  if (isWindows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else signalGroup(child, signal);
}

const isRunning = (child) => child.pid !== undefined && child.exitCode === null && child.signalCode === null;

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
