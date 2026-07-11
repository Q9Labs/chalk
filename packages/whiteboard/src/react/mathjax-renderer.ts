const MATHJAX_INPUT_EM = 16;
const MATHJAX_INPUT_EX = 8;
const MATHJAX_CONTAINER_WIDTH = 80 * MATHJAX_INPUT_EM;
const DEFAULT_MATHJAX_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/mathjax@4.1.3/tex-svg-nofont.js";

export interface RenderedMathSvg {
  svg: string;
  width: number;
  height: number;
}

interface MathJaxAdaptor {
  tags(node: unknown, name: string): unknown[];
  serializeXML(node: unknown): string;
}

interface MathJaxRuntime {
  startup: {
    adaptor: MathJaxAdaptor;
    promise: Promise<void>;
    [key: string]: unknown;
  };
  tex2svgPromise(tex: string, options: { display: boolean; em: number; ex: number; containerWidth: number }): Promise<unknown>;
}

declare global {
  interface Window {
    MathJax?: MathJaxRuntime & Record<string, unknown>;
  }

  var MathJax: (MathJaxRuntime & Record<string, unknown>) | undefined;
}

let mathJaxReady: Promise<MathJaxRuntime> | null = null;

const getMathJaxGlobal = () => (typeof window === "undefined" ? globalThis.MathJax : window.MathJax);

// MathJax exposes readiness through a late-installed browser global.
// fallow-ignore-next-line complexity
async function waitForMathJaxRuntime(): Promise<MathJaxRuntime> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5000) {
    const runtime = getMathJaxGlobal();
    if (runtime?.startup?.promise && typeof runtime.tex2svgPromise === "function") {
      await runtime.startup.promise;
      return runtime;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Math renderer failed to initialize");
}

// Existing global configuration must be preserved when a host initializes MathJax first.
// fallow-ignore-next-line complexity
function configureMathJax(target: typeof globalThis | Window, existing: (MathJaxRuntime & Record<string, unknown>) | undefined): void {
  target.MathJax = {
    ...(existing ?? {}),
    options: { ...(existing?.options as object | undefined), enableMenu: false },
    startup: { ...(existing?.startup as object | undefined), typeset: false },
    svg: { fontCache: "none", ...(existing?.svg as object | undefined) },
  } as unknown as MathJaxRuntime & Record<string, unknown>;
}

function loadMathJaxScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-chalk-mathjax="true"]');
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Math renderer failed to load")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = DEFAULT_MATHJAX_SCRIPT_URL;
    script.async = true;
    script.dataset.chalkMathjax = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Math renderer failed to load"));
    document.head.appendChild(script);
  });
}

// Browser and preloaded-runtime branches are both supported public integration paths.
// fallow-ignore-next-line complexity
async function initializeMathJax(): Promise<MathJaxRuntime> {
  if (typeof document === "undefined") throw new Error("Math rendering is only available in the browser");

  const target = typeof window === "undefined" ? globalThis : window;
  const existing = getMathJaxGlobal();
  if (existing?.tex2svgPromise && existing.startup?.promise) {
    await existing.startup.promise;
    return existing;
  }

  configureMathJax(target, existing);
  await loadMathJaxScript();
  return waitForMathJaxRuntime();
}

async function loadMathJax(): Promise<MathJaxRuntime> {
  if (mathJaxReady) return mathJaxReady;
  mathJaxReady = initializeMathJax();
  return mathJaxReady;
}

const parseSvgLength = (value: string | null, unitScale: number) => {
  if (!value) return null;
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric * unitScale;
};

// MathJax emits multiple valid SVG dimension formats that require ordered fallbacks.
// fallow-ignore-next-line complexity
export function getRenderedSvgSize(svg: string): { width: number; height: number } {
  const widthAttr = /<svg\b[^>]*\bwidth="([^"]+)"/u.exec(svg)?.[1] ?? null;
  const heightAttr = /<svg\b[^>]*\bheight="([^"]+)"/u.exec(svg)?.[1] ?? null;
  const viewBox = /<svg\b[^>]*\bviewBox="([^"]+)"/u.exec(svg)?.[1] ?? null;

  const width = parseSvgLength(widthAttr, widthAttr?.endsWith("ex") ? MATHJAX_INPUT_EX : 1);
  const height = parseSvgLength(heightAttr, heightAttr?.endsWith("ex") ? MATHJAX_INPUT_EX : 1);

  if (width && height) {
    return {
      width: Math.max(64, Math.ceil(width + 24)),
      height: Math.max(40, Math.ceil(height + 24)),
    };
  }

  const [, , viewBoxWidth, viewBoxHeight] = viewBox?.split(/\s+/u).map(Number) ?? [];
  if (viewBoxWidth && viewBoxHeight && Number.isFinite(viewBoxWidth) && Number.isFinite(viewBoxHeight)) {
    return {
      width: Math.max(64, Math.ceil(viewBoxWidth / 40 + 24)),
      height: Math.max(40, Math.ceil(viewBoxHeight / 40 + 24)),
    };
  }

  return { width: 240, height: 96 };
}

export async function renderLatexToSvg(latex: string, displayMode = true): Promise<RenderedMathSvg> {
  const runtime = await loadMathJax();
  const node = await runtime.tex2svgPromise(latex, {
    display: displayMode,
    em: MATHJAX_INPUT_EM,
    ex: MATHJAX_INPUT_EX,
    containerWidth: MATHJAX_CONTAINER_WIDTH,
  });

  const svgNode = runtime.startup.adaptor.tags(node, "svg")[0];
  if (!svgNode) throw new Error("Math renderer did not produce SVG");

  const svg = runtime.startup.adaptor.serializeXML(svgNode);
  return {
    svg,
    ...getRenderedSvgSize(svg),
  };
}
