import { Socket, isIP } from "node:net";

const localHosts = new Set(["localhost", "::1"]);
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const hostname = connectionHostname(args);
  if (hostname !== null && !localHosts.has(hostname) && !(isIP(hostname) === 4 && hostname.startsWith("127."))) {
    const error = new Error(`Unit test blocked a real network connection to ${hostname}. Supply a fake transport or a loopback base URL.`);
    // SDK cleanup can catch transport errors. The attempted connection must still fail the run.
    process.exitCode = 1;
    queueMicrotask(() => {
      throw error;
    });
    throw error;
  }
  return Reflect.apply(connect, this, args);
};

function connectionHostname(args) {
  // Node also passes its normalized argument array between socket implementations.
  const [options, host] = Array.isArray(args[0]) ? args[0] : args;
  if (typeof options === "object") return options.path ? null : (options.host ?? "localhost");
  return typeof host === "string" ? host : "localhost";
}
