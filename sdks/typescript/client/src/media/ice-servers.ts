import type { SFUBootstrap } from "./types";
export function iceServersFor(bootstrap: SFUBootstrap): RTCIceServer[] {
  return bootstrap.iceServers.map(({ urls, username, credential }) => (username === undefined || credential === undefined ? { urls: [...urls] } : { urls: [...urls], username, credential }));
}
