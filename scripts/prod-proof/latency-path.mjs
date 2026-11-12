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

const BLOCK_UDP_ARG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

/** Chromium launch arguments a path needs. */
export const chromiumArgsFor = (/** @type {IcePath} */ path) => (path.startsWith("blocked-") ? [BLOCK_UDP_ARG] : []);

/** Whether the path is expected to reach the SFU. A path that cannot is measured as a failed join, not as a broken run. */
export const joinExpected = (/** @type {IcePath} */ path) => path !== "blocked-no-relay";

/**
 * pathMismatch compares the path a cycle asked for with the pair the browser selected, which is the only evidence of how the media
 * travelled: the configuration alone proves nothing (the direct path keeps the TURN servers, so it can end up on the relay).
 * It returns why the reading does not show the path, or null when it does. A missing reading is a mismatch.
 * @param {IcePath} path
 * @param {{ local_type: string | null, remote_type: string | null, protocol: string | null, relay_protocol: string | null } | null | undefined} ice
 * @returns {string | null}
 */
export function pathMismatch(path, ice) {
  if (!ice) return `${path}: no selected ICE pair was read, so the path is unconfirmed`;
  const seen = `${ice.local_type ?? "?"}/${ice.remote_type ?? "?"} ${ice.local_type === "relay" ? `relay ${ice.relay_protocol ?? "?"}` : (ice.protocol ?? "?")}`;
  const relay = ice.local_type === "relay";
  const wanted = {
    direct: !relay && ice.local_type !== null && ice.protocol === "udp",
    "relay-udp": relay && ice.relay_protocol === "udp",
    "relay-tcp": relay && ice.relay_protocol === "tcp",
    "relay-tls": relay && ice.relay_protocol === "tls",
    "blocked-no-relay": !relay && ice.local_type !== null && ice.protocol === "tcp",
    "blocked-relay-tls": relay && ice.relay_protocol === "tls",
  }[path];
  return wanted ? null : `${path}: the selected pair is ${seen}`;
}

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
