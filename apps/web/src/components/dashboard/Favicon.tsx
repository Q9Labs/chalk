import { useState } from "react";

/** A website's own icon, served by Chalk's own origin (visitors never contact the site), or a lettered tile when it has none. */
export function Favicon({ host, large }: { readonly host: string; readonly large?: boolean }) {
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const size = large ? "fav lg" : "fav";
  if (state === "missing")
    return (
      <span className={`${size} tile`} aria-hidden="true">
        {host.charAt(0).toUpperCase()}
      </span>
    );
  return (
    <span className={size} aria-hidden="true" data-state={state}>
      <img src={`/dashboard-api/favicon?host=${encodeURIComponent(host)}`} alt="" width={large ? 28 : 20} height={large ? 28 : 20} onLoad={() => setState("ready")} onError={() => setState("missing")} />
    </span>
  );
}

/** `portal.tuitionhighway.com` from `https://portal.tuitionhighway.com:8443/path`. */
export function hostOf(address: string): string {
  try {
    return new URL(address).hostname;
  } catch {
    return address;
  }
}
