/** Whether entry may start without another gesture. An automated browser carries no listener and keeps unattended entry; a person's browser needs its own autoplay evidence. */
export function browserAllowsAutomaticEntry(): boolean {
  if (globalThis.navigator?.webdriver === true) return true;
  const navigatorWithPolicy = globalThis.navigator as Navigator & { readonly getAutoplayPolicy?: (type: "mediaelement") => string };
  const policy = navigatorWithPolicy.getAutoplayPolicy?.("mediaelement");
  if (policy) return policy === "allowed";
  const Context = globalThis.AudioContext;
  if (!Context) return false;
  try {
    const context = new Context();
    const allowed = context.state === "running";
    void context.close().catch(() => undefined);
    return allowed;
  } catch {
    return false;
  }
}
