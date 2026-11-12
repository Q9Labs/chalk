// Network paths the latency kit can force on its guests, to measure what each way of reaching the SFU costs.
//
//   direct             the browser's own ICE choice (host or server-reflexive UDP to the node)
//   relay-udp          only TURN over UDP candidates
//   relay-tcp          only TURN over TCP candidates
//   relay-tls          only TURN over TLS (turns:), preferring port 443
//   blocked-no-relay   no UDP at all and no TURN server: the case a UDP-blocking network without a relay is in
//   blocked-relay-tls  no UDP at all, TURN over TLS only: a UDP-blocking network with a relay on 443
//
// "Blocked" is the browser's own switch (--force-webrtc-ip-handling-policy=disable_non_proxied_udp), which drops every UDP
// socket the page opens. The relay modes rewrite the RTCPeerConnection configuration in the guest page before any other
// wrapper sees it, so the SDK and the product code are not changed.

/** @typedef {"direct" | "relay-udp" | "relay-tcp" | "relay-tls" | "blocked-no-relay" | "blocked-relay-tls"} IcePath */

export { ICE_PATHS } from "../../features/scorecard/diagnostics.mjs";

/** The relay protocols a relay candidate reports (RTCIceCandidateStats.relayProtocol). */
export const RELAY_PROTOCOLS = ["udp", "tcp", "tls"];

const BLOCK_UDP_ARG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

/** Chromium launch arguments a path needs. */
export const chromiumArgsFor = (/** @type {IcePath} */ path) => (path.startsWith("blocked-") ? [BLOCK_UDP_ARG] : []);

/** Whether the path is expected to reach the SFU. A path that cannot is measured as a failed join, not as a broken run. */
export const joinExpected = (/** @type {IcePath} */ path) => path !== "blocked-no-relay";

/**
 * installIcePath runs in a guest page as an init script, installed after every other RTCPeerConnection wrapper so it
 * rewrites the configuration first. It keeps only the ICE servers the path allows and, for relay paths, forces relay candidates.
 * @param {IcePath} path
 */
export function installIcePath(path) {
  const transportOf = (url) => /[?&]transport=(udp|tcp)/.exec(url)?.[1] ?? null;
  const portOf = (url) => Number(/^turns?:[^:/?]+:(\d+)/.exec(url)?.[1] ?? 0);
  const keep = (url) => {
    if (url.startsWith("turn:")) return (path === "relay-udp" && transportOf(url) === "udp") || (path === "relay-tcp" && transportOf(url) === "tcp");
    if (url.startsWith("turns:")) return (path === "relay-tls" || path === "blocked-relay-tls") && transportOf(url) !== "udp";
    return false;
  };
  const rewrite = (configuration) => {
    const servers = [];
    for (const server of configuration?.iceServers ?? []) {
      const all = [server.urls].flat();
      let urls = all.filter(keep);
      // TLS paths use port 443 when the relay offers it; the relay's other TLS port is only a fallback.
      if (urls.some((url) => url.startsWith("turns:")) && urls.some((url) => portOf(url) === 443)) urls = urls.filter((url) => portOf(url) === 443);
      if (urls.length) servers.push({ ...server, urls });
    }
    const relayOnly = path === "relay-udp" || path === "relay-tcp" || path === "relay-tls" || path === "blocked-relay-tls";
    return { ...configuration, iceServers: servers, ...(relayOnly ? { iceTransportPolicy: "relay" } : {}) };
  };
  if (path === "direct") return;
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Native, {
    construct: (target, args, newTarget) => Reflect.construct(target, [rewrite(args[0]), ...args.slice(1)], newTarget),
  });
}
