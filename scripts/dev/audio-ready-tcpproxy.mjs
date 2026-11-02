// node audio-ready-tcpproxy.mjs <listen-host> <target-host> <port>...  Forwards each TCP port on <listen-host> to the same port on <target-host>.
import { createServer, connect } from "node:net";

const [listenHost, targetHost, ...ports] = process.argv.slice(2);
for (const port of ports.map(Number)) {
  createServer((client) => {
    const upstream = connect(port, targetHost);
    client.pipe(upstream).pipe(client);
    for (const socket of [client, upstream]) socket.on("error", () => (client.destroy(), upstream.destroy()));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }).listen(port, listenHost);
}
