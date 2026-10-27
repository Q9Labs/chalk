import { Socket, isIP } from "node:net";

const localHosts = new Set(["localhost", "::1"]);
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const hostname = connectionHostname(...normalized);
  if (!isLocal(hostname)) {
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

// Node also passes its normalized argument array between socket implementations.
function connectionHostname(options, host) {
  if (typeof options === "object") return options.path ? "localhost" : options.host;
  return typeof host === "string" ? host : "localhost";
}

function isLocal(hostname = "localhost") {
  return localHosts.has(hostname) || (isIP(hostname) === 4 && hostname.startsWith("127."));
}
