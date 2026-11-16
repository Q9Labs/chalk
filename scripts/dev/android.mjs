import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

export async function connectedSerial(run, env = process.env) {
  if (env.ADB_SERIAL) return env.ADB_SERIAL;
  const { stdout } = await run("adb", ["devices"]);
  const serial = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((fields) => fields[1] === "device")?.[0];
  if (!serial) throw new Error("No connected adb device. Set ADB_SERIAL or connect a device in Android Studio.");
  return serial;
}

export async function androidLogs({ run, spawn, output = process.stdout, env = process.env }) {
  const serial = await connectedSerial(run, env);
  const child = spawn("adb", ["-s", serial, "logcat"], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (/ReactNativeJS|chalk|Expo/.test(line)) output.write(`${line}\n`);
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code ? reject(new Error(`adb logcat exited ${code}`)) : resolve()));
  });
}

export function parseInstallArguments(argv) {
  const options = { variant: "debug", delivery: "push", launch: true, remoteDir: "/sdcard/Download" };
  const values = { "--connect": "connect", "--pair": "pair", "--code": "code", "--remote-dir": "remoteDir", "--remote-name": "remoteName" };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (values[flag]) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      options[values[flag]] = value;
    } else if (["--debug", "--release"].includes(flag)) options.variant = flag.slice(2);
    else if (["--install", "--push"].includes(flag)) options.delivery = flag.slice(2);
    else if (flag === "--skip-build") options.skipBuild = true;
    else if (flag === "--no-launch") options.launch = false;
    else if (["--help", "-h"].includes(flag)) options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.pair && !options.code) throw new Error("--pair requires --code");
  if (options.remoteName && /[/\\]/.test(options.remoteName)) throw new Error("--remote-name must be a filename");
  return options;
}

export async function installLocalApk(argv, { root, run, platform = process.platform, env = process.env, output = console.log }) {
  const options = parseInstallArguments(argv);
  if (options.help) return output("pnpm mobile:install:local [--debug|--release] [--connect ip:port] [--pair ip:port --code code] [--skip-build] [--install|--push] [--remote-dir path] [--remote-name name.apk] [--no-launch]");
  if (options.pair) await run("adb", ["pair", options.pair, options.code]);
  if (options.connect) await run("adb", ["connect", options.connect]);
  const serial = env.ADB_SERIAL || options.connect || (await connectedSerial(run, env));
  const apk = join(root, "apps/mobile/android/app/build/outputs/apk", options.variant, `app-${options.variant}.apk`);
  if (!options.skipBuild) await run(platform === "win32" ? "gradlew.bat" : "./gradlew", [options.variant === "release" ? "assembleRelease" : "assembleDebug"], { cwd: join(root, "apps/mobile/android") });
  await access(apk);
  let delivered = options.delivery;
  if (delivered === "install") {
    try {
      const result = await run("adb", ["-s", serial, "install", "-r", "-t", "-g", apk]);
      output(result.stdout);
    } catch (error) {
      if (!/INSTALL_FAILED_USER_RESTRICTED/.test(`${error.stdout || ""}${error.stderr || ""}`)) throw error;
      output("Device policy blocked adb install. Pushing the APK to Downloads.");
      delivered = "push";
    }
  }
  if (delivered === "push") {
    const name = options.remoteName || `chalk-mobile-${options.variant}-${Date.now()}-${randomBytes(4).toString("hex")}.apk`;
    const remote = `${options.remoteDir.replace(/\/$/, "")}/${name}`;
    await run("adb", ["-s", serial, "push", apk, remote]);
    await run("adb", ["-s", serial, "shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${remote}`]).catch(() => {});
    await run("adb", ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `file://${remote}`, "-t", "application/vnd.android.package-archive"]).catch(() => {});
    output(`remote_apk=${remote}`);
  } else if (options.launch) {
    if (!env.CHALK_MOBILE_PACKAGE) throw new Error("Set CHALK_MOBILE_PACKAGE to launch, or pass --no-launch.");
    await run("adb", ["-s", serial, "shell", "monkey", "-p", env.CHALK_MOBILE_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"]);
  }
  output(`delivery=${delivered}\nserial=${serial}\napk=${apk}`);
}
