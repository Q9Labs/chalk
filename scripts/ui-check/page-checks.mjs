// Deterministic layout checks. `pageChecks` runs inside the page (Playwright serializes it), so it must stay
// self-contained: no imports, no references to module scope. Each finding has a `key` that names the problem without
// pixel positions, so the same problem on master and on a branch compares equal.

/** @typedef {{ check: string, key: string, detail: string }} Finding */

export const CHECKS = ["blank", "page-scroll", "viewport-overflow", "child-clipped", "frame-unfilled", "text-clipped", "control-overlap", "control-covered", "tap-target"];

/** Smallest touch or pointer target in CSS pixels, from WCAG 2.2 success criterion 2.5.8. */
export const MIN_TARGET = 24;

/**
 * @param {{ minTarget: number, perCheck: number }} options
 * @returns {Finding[]}
 */
export function pageChecks(options) {
  const { minTarget, perCheck } = options;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const findings = [];
  const counts = new Map();
  const seen = new Set();
  const add = (check, key, detail) => {
    const full = `${check}|${key}`;
    if (seen.has(full)) return;
    seen.add(full);
    const count = (counts.get(check) ?? 0) + 1;
    counts.set(check, count);
    if (count <= perCheck) findings.push({ check, key, detail });
  };

  const style = (el) => getComputedStyle(el);
  const describe = (el) => {
    const parts = [el.tagName.toLowerCase()];
    const role = el.getAttribute("role");
    if (role) parts.push(`[role=${role}]`);
    const label = el.getAttribute("aria-label") ?? el.getAttribute("data-testid") ?? el.getAttribute("name");
    if (label) parts.push(`[${label.slice(0, 40)}]`);
    else {
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
      if (text) parts.push(`"${text}"`);
    }
    return parts.join("");
  };
  const isHidden = (el) => !el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const inertOrHidden = (el) => el.closest("[inert], [aria-hidden='true']") !== null;
  const clipsAxis = (value) => value !== "visible";

  // The rectangle of `el` that is not cut off by an ancestor that clips; null when nothing shows.
  const visibleRect = (el) => {
    const box = el.getBoundingClientRect();
    let left = box.left;
    let top = box.top;
    let right = box.right;
    let bottom = box.bottom;
    let position = style(el).position;
    for (let parent = el.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      if (position === "fixed") break;
      const parentStyle = style(parent);
      const skipsParent = position === "absolute" && parentStyle.position === "static";
      if (!skipsParent) {
        if (clipsAxis(parentStyle.overflowX) || clipsAxis(parentStyle.overflowY)) {
          const parentBox = parent.getBoundingClientRect();
          if (clipsAxis(parentStyle.overflowX)) {
            left = Math.max(left, parentBox.left);
            right = Math.min(right, parentBox.right);
          }
          if (clipsAxis(parentStyle.overflowY)) {
            top = Math.max(top, parentBox.top);
            bottom = Math.min(bottom, parentBox.bottom);
          }
        }
        position = parentStyle.position;
      }
    }
    if (right - left <= 0 || bottom - top <= 0) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  const everything = [...document.body.querySelectorAll("*")].filter((el) => !isHidden(el) && !(el instanceof SVGElement && el.closest("svg") !== el && el.tagName !== "svg"));
  const controlSelector = "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=slider], [role=link], [tabindex]:not([tabindex='-1'])";
  const controls = everything.filter((el) => el.matches(controlSelector) && !inertOrHidden(el) && style(el).pointerEvents !== "none");
  const shownControls = controls.map((el) => ({ el, rect: visibleRect(el) })).filter((item) => item.rect && item.rect.width >= 2 && item.rect.height >= 2);

  // blank: a page that rendered nothing a person could see.
  const hasMedia = everything.some((el) => ["CANVAS", "VIDEO", "IMG", "svg"].includes(el.tagName) || el.tagName === "svg");
  if ((document.body.innerText ?? "").trim().length === 0 && !hasMedia) add("blank", "page", "the page has no visible text or media");

  // page-scroll: the page scrolls sideways.
  const scroller = document.scrollingElement;
  if (scroller && scroller.scrollWidth > vw + 1) add("page-scroll", "document", `page is ${scroller.scrollWidth}px wide in a ${vw}px viewport`);

  // viewport-overflow: something shows outside the viewport sideways, or a fixed layer runs off the top or bottom.
  for (const el of everything) {
    if (inertOrHidden(el)) continue;
    const rect = visibleRect(el);
    if (!rect || rect.width < 2 || rect.height < 2) continue;
    const fixed = style(el).position === "fixed";
    const sideways = rect.right > vw + 1 || rect.left < -1;
    const vertical = fixed && (rect.bottom > vh + 1 || rect.top < -1);
    if (!sideways && !vertical) continue;
    // Only report the outermost element; its children inherit the same problem.
    const parent = el.parentElement;
    const parentRect = parent && parent !== document.body ? visibleRect(parent) : null;
    if (parentRect && (parentRect.right > vw + 1 || parentRect.left < -1 || (fixed && (parentRect.bottom > vh + 1 || parentRect.top < -1)))) continue;
    add("viewport-overflow", describe(el), `${describe(el)} spans ${Math.round(rect.left)}..${Math.round(rect.right)} x ${Math.round(rect.top)}..${Math.round(rect.bottom)} in a ${vw}x${vh} viewport`);
  }

  // child-clipped and text-clipped: content that a parent cuts off.
  for (const el of everything) {
    if (inertOrHidden(el)) continue;
    const own = style(el);
    const hasText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
    const clipsX = own.overflowX === "hidden" || own.overflowX === "clip";
    if (hasText && clipsX && el.scrollWidth > el.clientWidth + 1 && own.textOverflow !== "ellipsis" && own.display !== "inline") {
      add("text-clipped", describe(el), `${describe(el)} text is ${el.scrollWidth}px in a ${el.clientWidth}px box and is cut off`);
    }
    const lines = own.webkitLineClamp;
    if (hasText && (own.overflowY === "hidden" || own.overflowY === "clip") && (!lines || lines === "none") && el.scrollHeight > el.clientHeight + 2 && own.display !== "inline" && el.clientHeight > 0) {
      add("text-clipped", describe(el), `${describe(el)} text is ${el.scrollHeight}px tall in a ${el.clientHeight}px box and is cut off`);
    }
    const parent = el.parentElement;
    if (!parent || parent === document.body || (!hasText && !el.matches(controlSelector))) continue;
    const parentStyle = style(parent);
    const position = own.position;
    if (position === "fixed" || position === "absolute") continue;
    const cutsX = parentStyle.overflowX === "hidden" || parentStyle.overflowX === "clip";
    const cutsY = parentStyle.overflowY === "hidden" || parentStyle.overflowY === "clip";
    if (!cutsX && !cutsY) continue;
    const box = el.getBoundingClientRect();
    const parentBox = parent.getBoundingClientRect();
    if (box.width < 2 || box.height < 2 || parentBox.width < 2) continue;
    const outX = cutsX && (box.right > parentBox.right + 2 || box.left < parentBox.left - 2);
    const outY = cutsY && (box.bottom > parentBox.bottom + 2 || box.top < parentBox.top - 2);
    if (outX || outY) add("child-clipped", `${describe(parent)} > ${describe(el)}`, `${describe(el)} sticks out of ${describe(parent)}, which cuts it off`);
  }

  // child-clipped, for pictures: an image, canvas, svg or round avatar that a parent cuts off. Unlike the loop above this
  // also looks inside aria-hidden subtrees, because decorative pictures are still seen by people.
  for (const el of everything) {
    const own = style(el);
    if (own.position === "fixed") continue;
    const box = el.getBoundingClientRect();
    if (box.width < 16 || box.height < 16) continue;
    const round = Number.parseFloat(own.borderTopLeftRadius) >= Math.min(box.width, box.height) / 2 - 1 && own.overflowX !== "visible";
    if (!round && !["IMG", "CANVAS", "svg"].includes(el.tagName)) continue;
    const rect = visibleRect(el);
    // A picture that is entirely hidden (a remote cursor beyond the board's edge) is out of view, not cut off.
    if (!rect) continue;
    const lostX = box.width - rect.width;
    const lostY = box.height - rect.height;
    if (lostX > 4 || lostY > 4) add("child-clipped", `${describe(el)} picture`, `${describe(el)} is ${Math.round(box.width)}x${Math.round(box.height)} and a parent cuts off ${Math.round(Math.max(lostX, lostY))}px of it`);
  }

  // frame-unfilled: a round frame that clips (an avatar) whose one child sits flush against one side and stops short of the
  // other, such as a face drawn 24px wide in a 28px circle. A child centered in its frame has equal gaps and is fine.
  for (const frame of everything) {
    if (inertOrHidden(frame) || frame.children.length !== 1) continue;
    const own = style(frame);
    const box = frame.getBoundingClientRect();
    if (box.width < 16 || box.height < 16 || own.overflowX === "visible" || Number.parseFloat(own.borderTopLeftRadius) < Math.min(box.width, box.height) / 2 - 1) continue;
    const child = frame.children[0].getBoundingClientRect();
    const uneven = Math.abs(child.left - box.left - (box.right - child.right)) > 2 || Math.abs(child.top - box.top - (box.bottom - child.bottom)) > 2;
    if (!uneven || child.width < 2) continue;
    const named = frame.closest("[aria-label]") ?? frame;
    add("frame-unfilled", `${describe(named)} face`, `${describe(frame)} is ${Math.round(box.width)}x${Math.round(box.height)} but its content is ${Math.round(child.width)}x${Math.round(child.height)}, flush on one side and short on the other`);
  }

  // control-overlap: two controls share screen area and neither sits inside the other.
  for (let i = 0; i < shownControls.length; i += 1) {
    for (let j = i + 1; j < shownControls.length; j += 1) {
      const a = shownControls[i];
      const b = shownControls[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (width <= 2 || height <= 2) continue;
      const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
      if ((width * height) / smaller < 0.1) continue;
      const names = [describe(a.el), describe(b.el)].sort();
      add("control-overlap", names.join(" + "), `${names[0]} and ${names[1]} overlap by ${Math.round(width)}x${Math.round(height)}px`);
    }
  }

  // control-covered: something else answers a click at the control's center.
  for (const { el, rect } of shownControls) {
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio" || el.type === "file") && (el.labels?.length ?? 0) > 0) continue;
    const top = document.elementFromPoint(x, y);
    if (!top || el.contains(top) || top.contains(el)) continue;
    if (el.labels && [...el.labels].some((label) => label.contains(top))) continue;
    add("control-covered", describe(el), `${describe(el)} is covered at its center by ${describe(top)}`);
  }

  // tap-target: a control smaller than the minimum. Links inside running text are exempt, as in WCAG 2.2.
  for (const { el, rect } of shownControls) {
    const inline = el.tagName === "A" && style(el).display === "inline";
    if (inline) continue;
    if (el instanceof HTMLInputElement && (el.labels?.length ?? 0) > 0) continue;
    if (rect.width < minTarget - 0.5 || rect.height < minTarget - 0.5) {
      add("tap-target", describe(el), `${describe(el)} is ${Math.round(rect.width)}x${Math.round(rect.height)}px, under ${minTarget}px`);
    }
  }

  return findings;
}
