import { spawn } from "node:child_process";

export function runBoundedCommand(command, arguments_, { cwd, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const append = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        reject(new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = { code, signal, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} exited ${code ?? signal}: ${result.stderr.toString("utf8").slice(-2_000)}`));
    });
  });
}
