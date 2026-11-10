import { execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import path from "node:path";

export function createPki(directory, identity) {
  const run = (...args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "inherit"] });
  const ca = { key: path.join(directory, "ca.key"), cert: path.join(directory, "ca.pem") };
  run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", ca.key);
  run("req", "-new", "-x509", "-key", ca.key, "-sha256", "-days", "1", "-subj", "/CN=sfu-browser-ca", "-out", ca.cert, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  const issue = (name, subjectAltName, usage) => {
    const files = { key: path.join(directory, `${name}.key`), csr: path.join(directory, `${name}.csr`), cert: path.join(directory, `${name}.pem`), ext: path.join(directory, `${name}.ext`) };
    run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", files.key);
    run("req", "-new", "-key", files.key, "-subj", `/CN=${name}`, "-out", files.csr);
    writeFileSync(files.ext, `subjectAltName=${subjectAltName}\nextendedKeyUsage=${usage}\nkeyUsage=digitalSignature\n`);
    run("x509", "-req", "-in", files.csr, "-CA", ca.cert, "-CAkey", ca.key, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", files.ext, "-out", files.cert);
    return { key: files.key, cert: files.cert };
  };
  return { ca: ca.cert, server: issue("server", "DNS:localhost,IP:127.0.0.1", "serverAuth"), client: issue("client", `DNS:${identity}`, "clientAuth") };
}

function controlClient(port, certs) {
  const options = { host: "127.0.0.1", port, servername: "localhost", ca: readFileSync(certs.ca), cert: readFileSync(certs.client.cert), key: readFileSync(certs.client.key) };
  const send = (method, route, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = https.request({ ...options, method, path: route, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined });
        });
      });
      request.on("error", reject);
      request.end(payload);
    });
  return { get: (route) => send("GET", route), post: (route, body) => send("POST", route, body) };
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

export async function startSfu({ work, sourceDir, certs, identity, children, stdio, onOutput }) {
  const binary = path.join(work, "sfu");
  execFileSync("go", ["build", "-o", binary, "./cmd/sfu"], { cwd: sourceDir, stdio: "inherit" });
  const controlPort = await freeTcpPort();
  const udpPort = await freeUdpPort();
  const sfu = spawn(binary, [], {
    stdio,
    env: {
      ...process.env,
      SFU_CONTROL_ADDR: `127.0.0.1:${controlPort}`,
      SFU_UDP_ADDR: `127.0.0.1:${udpPort}`,
      SFU_ANNOUNCE_IPS: "127.0.0.1",
      SFU_ICE_LOOPBACK: "true",
      SFU_TLS_CERT_FILE: certs.server.cert,
      SFU_TLS_KEY_FILE: certs.server.key,
      SFU_CLIENT_CA_FILE: certs.ca,
      SFU_CLIENT_IDENTITY: identity,
      // The harness grants once rather than renewing source leases through Sync.
      SFU_SOURCE_LEASE_TTL: "2m",
    },
  });
  if (onOutput) {
    for (const stream of [sfu.stdout, sfu.stderr]) onOutput(stream);
  }
  children.push(sfu);
  return controlClient(controlPort, certs);
}

export async function cleanupHarness({ browser, children, work, beforeCleanup }) {
  await beforeCleanup?.();
  await browser?.close().catch(() => undefined);
  for (const child of children) {
    child.kill("SIGTERM");
    await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve()));
  }
  rmSync(work, { recursive: true, force: true });
}
