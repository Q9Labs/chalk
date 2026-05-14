import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import net from "node:net";
import { execFileSync } from "node:child_process";

const expoPort = 8088;
const proxyMappings = [
  [8081, 8088],
  [8082, 8089],
  [8083, 8090],
];
const bundlePath = "/apps/mobile/index.bundle?platform=ios&dev=true&hot=true&lazy=true&transform.routerRoot=app";

function getLanIp() {
  const interfaces = os.networkInterfaces();
  const preferred = ["en0", "en1"];

  for (const name of preferred) {
    const entries = interfaces[name] ?? [];
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  throw new Error("Could not determine a LAN IPv4 address for the simulator bridge.");
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 500) {
          resolve();
          return;
        }

        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${url} (status ${response.statusCode ?? "unknown"}).`));
          return;
        }

        setTimeout(attempt, 500);
      });

      request.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${url}.`));
          return;
        }

        setTimeout(attempt, 500);
      });
    };

    attempt();
  });
}

function prewarmBundle(bundleUrl) {
  return new Promise((resolve, reject) => {
    console.log(`Prewarming iOS bundle via ${bundleUrl}`);

    const request = http.get(bundleUrl, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Bundle prewarm failed with HTTP ${response.statusCode ?? "unknown"}.`));
        return;
      }

      response.on("data", () => {});
      response.on("end", resolve);
    });

    request.setTimeout(180_000, () => {
      request.destroy(new Error("Bundle prewarm timed out after 180 seconds."));
    });
    request.on("error", reject);
  });
}

function startProxy(listenPort, targetPort) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: "::1", port: targetPort });

    client.pipe(upstream);
    upstream.pipe(client);

    const close = () => {
      client.destroy();
      upstream.destroy();
    };

    client.on("error", close);
    upstream.on("error", close);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "0.0.0.0", () => {
      console.log(`Proxy ${listenPort} -> [::1]:${targetPort}`);
      resolve(server);
    });
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

function getAdbDevices() {
  try {
    const output = execFileSync("adb", ["devices"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .filter(([serial, state]) => Boolean(serial) && state === "device")
      .map(([serial]) => serial);
  } catch {
    return [];
  }
}

function reverseAdbPorts() {
  const devices = getAdbDevices();
  if (devices.length === 0) {
    return;
  }

  for (const serial of devices) {
    for (const [listenPort] of proxyMappings) {
      try {
        execFileSync("adb", ["-s", serial, "reverse", `tcp:${listenPort}`, `tcp:${listenPort}`], {
          stdio: ["ignore", "ignore", "ignore"],
        });
        console.log(`adb reverse ${serial} tcp:${listenPort}`);
      } catch (error) {
        console.warn(`Failed adb reverse for ${serial} on port ${listenPort}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function getBootedAppleSimulators() {
  try {
    const output = execFileSync("xcrun", ["simctl", "list", "devices", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output);
    const devices = Object.values(parsed.devices ?? {}).flatMap((entries) => entries ?? []);

    return devices.filter((device) => device.state === "Booted" && typeof device.udid === "string").map((device) => device.udid);
  } catch {
    return ["booted"];
  }
}

async function main() {
  const lanIp = getLanIp();
  const bundleUrl = `http://${lanIp}:8081${bundlePath}`;
  const projectUrl = `http://${lanIp}:${expoPort}`;
  const devClientUrl = `exp+chalk-mobile://expo-development-client/?url=${encodeURIComponent(projectUrl)}`;

  const expo = spawn("pnpm", ["exec", "expo", "start", "--clear", "--dev-client", "--host", "lan", "--port", String(expoPort)], {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    env: process.env,
  });

  const servers = [];
  const cleanup = () => {
    for (const server of servers) {
      server.close();
    }
    if (!expo.killed) {
      expo.kill("SIGINT");
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  expo.once("exit", (code) => {
    for (const server of servers) {
      server.close();
    }

    if (code && code !== 0) {
      process.exitCode = code;
    }
  });

  try {
    for (const [listenPort, targetPort] of proxyMappings) {
      servers.push(await startProxy(listenPort, targetPort));
    }

    reverseAdbPorts();

    await waitForHttp(`http://[::1]:${expoPort}/`, 30_000);
    await prewarmBundle(bundleUrl);

    console.log("Bundle prewarm finished.");
    console.log(`Opening iOS dev client with ${devClientUrl}`);

    for (const simulatorUdid of getBootedAppleSimulators()) {
      await runCommand("xcrun", ["simctl", "launch", simulatorUdid, "ai.q9labs.chalk.mobile"]).catch(() => {});
      await runCommand("xcrun", ["simctl", "openurl", simulatorUdid, devClientUrl]);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    cleanup();
    process.exitCode = 1;
  }
}

await main();
