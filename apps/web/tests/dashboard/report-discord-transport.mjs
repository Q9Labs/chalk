import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The API still validates a genuine HTTPS Discord destination. Only the proof
// process trusts this ephemeral certificate and tunnels that host to the fixture.
export async function createDiscordProofTransport(handler) {
  const directory = await mkdtemp(join(tmpdir(), "chalk-discord-proof-"));
  const certificate = join(directory, "certificate.pem");
  const key = join(directory, "key.pem");
  const sockets = new Set();
  let tls;
  let proxy;
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([tls, proxy].filter((server) => server?.listening).map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate, "-days", "1", "-subj", "/CN=discord.com", "-addext", "subjectAltName=DNS:discord.com"], { stdio: "ignore" });
    tls = createHTTPSServer({ key: await readFile(key), cert: await readFile(certificate) }, handler);
    await listen(tls, Number(process.env.CHALK_REPORT_TLS_PORT ?? 0));
    proxy = createHTTPServer((_request, response) => response.writeHead(403).end());
    proxy.on("connect", (request, socket, head) => {
      if (request.url !== "discord.com:443") return socket.destroy();
      const upstream = connect(tls.address().port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      for (const stream of [socket, upstream]) {
        sockets.add(stream);
        stream.on("close", () => sockets.delete(stream));
        stream.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
      }
    });
    await listen(proxy, Number(process.env.CHALK_REPORT_PROXY_PORT ?? 0));
    return { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, SSL_CERT_FILE: certificate, NO_PROXY: "127.0.0.1,localhost" }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}
