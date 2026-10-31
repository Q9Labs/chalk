import type { CloudflareSFUBootstrap } from "./types";
/** The server sends TURN with its STUN entry; an older server sends only `stunServer`. */
export function iceServersFor(bootstrap: CloudflareSFUBootstrap): RTCIceServer[] {
  if (!bootstrap.iceServers || bootstrap.iceServers.length === 0) return [{ urls: bootstrap.stunServer }];
  return bootstrap.iceServers.map(({ urls, username, credential }) => (username === undefined || credential === undefined ? { urls: [...urls] } : { urls: [...urls], username, credential }));
}
