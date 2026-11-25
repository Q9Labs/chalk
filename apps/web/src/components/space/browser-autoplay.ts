/** Whether this browser will let remote media start without another gesture. Evidence comes only from the browser's own autoplay state. */
export function browserAllowsMediaAutoplay(): boolean {
  const navigatorWithPolicy = globalThis.navigator as Navigator & { readonly getAutoplayPolicy?: (type: "mediaelement") => string };
  const policy = navigatorWithPolicy.getAutoplayPolicy?.("mediaelement");
  if (typeof policy === "string") return policy === "allowed";
  const Context = globalThis.AudioContext;
  if (!Context) return false;
  const context = new Context();
  const allowed = context.state === "running";
  void context.close().catch(() => undefined);
  return allowed;
}
