/** A layout-only DOM snapshot: never instantiate React callers, custom elements, or media resources. */
export function captureToastLayout(toast: HTMLElement): HTMLDivElement {
  const snapshot = document.createElement("div");
  copyAttributes(toast, snapshot);
  for (const child of toast.childNodes) snapshot.append(copyLayout(child));
  return snapshot;
}

function copyAttributes(source: Element, target: Element): void {
  for (const { name, value } of source.attributes) {
    if (!/^(?:on|src|href|xlink:href|id$|name$|action$|formaction$|autoplay$|autofocus$|role$|aria-live$|aria-atomic$|tabindex$|contenteditable$)/i.test(name)) target.setAttribute(name, value);
  }
}

function copyLayout(node: Node): Node {
  if (!(node instanceof Element)) return document.createTextNode(node instanceof Text ? node.data : "");
  const opaque = node.localName.includes("-") || /^(?:img|video|audio|canvas|iframe|object|embed|script|style|link|image|use|animate|animateMotion|animateTransform|set)$/.test(node.localName);
  if (opaque) {
    const placeholder = document.createElement("span");
    const size = node.getBoundingClientRect();
    placeholder.style.cssText = `display:inline-block;width:${size.width}px;height:${size.height}px;flex-shrink:0`;
    return placeholder;
  }
  const copy = document.createElementNS(node.namespaceURI, node.localName);
  copyAttributes(node, copy);
  for (const child of node.childNodes) copy.append(copyLayout(child));
  return copy;
}

/** Reflow cached markup at the current band's width without mounting the folded caller tree. */
export function measureToastLayout(stack: HTMLElement, snapshot: HTMLDivElement): number {
  const probe = captureToastLayout(snapshot);
  probe.dataset.part = "toast-measurement";
  probe.inert = true;
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, { position: "absolute", left: "0", top: "0", width: "max-content", visibility: "hidden", pointerEvents: "none", animation: "none", transition: "none", transform: "none" });
  stack.append(probe);
  try {
    return Math.max(probe.offsetHeight, Math.ceil(probe.getBoundingClientRect().height));
  } finally {
    probe.remove();
  }
}
