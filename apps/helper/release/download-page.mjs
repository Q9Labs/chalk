// The public Chalk Helper download page. One self-contained file: no external fonts, scripts or images.

const chalkIcon = `<svg viewBox="0 0 48 48" aria-hidden="true"><g transform="rotate(28 24 24)"><path d="M18 8h12v28a6 6 0 0 1-12 0z" fill="#f1f0ea"/><path d="M18 8h12l-1.5 4.5h-9z" fill="#f1f0ea" opacity=".45"/></g><circle cx="10.5" cy="41.5" r="1.7" fill="#f1f0ea" opacity=".55"/><circle cx="6.5" cy="37" r="1.2" fill="#f1f0ea" opacity=".4"/><circle cx="4" cy="43.5" r=".85" fill="#f1f0ea" opacity=".28"/></svg>`;

const appleLogo = `<svg viewBox="0 0 814 1000" aria-hidden="true"><path fill="currentColor" d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/></svg>`;

const windowsLogo = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2 2h9.5v9.5H2zM12.5 2H22v9.5h-9.5zM2 12.5h9.5V22H2zM12.5 12.5H22V22h-9.5z"/></svg>`;

const styles = `
:root { color-scheme: dark; --text: #ececee; --soft: #c4c6cc; --muted: #9a9ca3; --faint: #5f6168; --line: rgba(255,255,255,.08); --raised: #0c0c0c; --accent: #55aac9; }
* { box-sizing: border-box; }
html { background: #000; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 48px 20px;
  font: 16px/1.5 Figtree, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text);
  background: radial-gradient(900px 520px at 50% -10%, rgba(85,170,201,.16), transparent 70%), #000; -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 600px; }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 40px; }
.icon { width: 44px; height: 44px; border-radius: 11px; background: #16181c; display: grid; place-items: center; box-shadow: inset 0 0 0 1px var(--line); }
.icon svg { width: 30px; height: 30px; }
.name { font-weight: 600; font-size: 17px; letter-spacing: -.01em; }
.badge { font-size: 12px; font-weight: 600; color: #000; background: var(--accent); border-radius: 999px; padding: 2px 9px; }
h1 { font-size: clamp(32px, 6vw, 44px); line-height: 1.08; letter-spacing: -.025em; margin: 0 0 16px; font-weight: 650; color: #fff; }
.lead { color: var(--soft); font-size: 18px; margin: 0 0 36px; max-width: 520px; }
.downloads { display: grid; gap: 12px; }
.download { display: flex; align-items: center; gap: 16px; padding: 18px 20px; border-radius: 16px; text-decoration: none; color: inherit;
  background: var(--raised); box-shadow: inset 0 0 0 1px var(--line); transition: background .15s, box-shadow .15s, transform .15s; }
.download svg { width: 26px; height: 26px; flex: none; }
.download strong { display: block; font-size: 17px; font-weight: 600; }
.download span { display: block; color: var(--muted); font-size: 14px; }
a.download:hover { background: #161616; box-shadow: inset 0 0 0 1px rgba(255,255,255,.16); }
a.download:active { transform: translateY(1px); }
a.download:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
a.primary { background: #f1f0ea; color: #000; box-shadow: none; }
a.primary span { color: #44464c; }
a.primary:hover { background: #fff; box-shadow: none; }
.arrow { margin-left: auto; font-size: 20px; opacity: .55; }
.pending { color: var(--muted); }
.pending svg { opacity: .5; }
h2 { font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 56px 0 18px; }
ol { list-style: none; counter-reset: step; padding: 0; margin: 0; display: grid; gap: 18px; }
li { counter-increment: step; display: grid; grid-template-columns: 32px 1fr; gap: 14px; color: var(--soft); }
li::before { content: counter(step); width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-size: 14px; font-weight: 600; color: var(--text); box-shadow: inset 0 0 0 1px var(--line); background: var(--raised); }
li b { color: var(--text); font-weight: 600; }
footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--faint); font-size: 14px; }
`;

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function downloadPage({ channel, version, macDownload, storeHref }) {
  const nightly = channel === "staging";
  const title = nightly ? "Chalk Helper for Chalk Nightly" : "Chalk Helper";
  const mac = macDownload
    ? `<a class="download primary" href="${escapeAttribute(macDownload)}">${appleLogo}<div><strong>Download for Mac</strong><span>Version ${escapeAttribute(version)} · macOS 14 or later · Apple silicon and Intel</span></div><span class="arrow" aria-hidden="true">↓</span></a>`
    : `<div class="download pending">${appleLogo}<div><strong>Mac</strong><span>The Mac download isn’t available yet.</span></div></div>`;
  const windows = storeHref
    ? `<a class="download" href="${escapeAttribute(storeHref)}" rel="noopener">${windowsLogo}<div><strong>Get it from the Microsoft Store</strong><span>Windows 10 version 2004 or later, and Windows 11 · x64</span></div><span class="arrow" aria-hidden="true">→</span></a>`
    : `<div class="download pending">${windowsLogo}<div><strong>Windows</strong><span>Coming soon to the Microsoft Store.</span></div></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Chalk Helper shows other participants’ annotations on the screen you share in Chalk.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#16181c"/>${chalkIcon.replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg>`)}">
<style>${styles}</style>
</head>
<body>
<main>
  <div class="brand"><div class="icon">${chalkIcon}</div><span class="name">Chalk Helper</span>${nightly ? '<span class="badge">Nightly</span>' : ""}</div>
  <h1>See annotations right on the screen you’re sharing.</h1>
  <p class="lead">When you share your screen in Chalk, others can draw on it. Chalk Helper puts their marks on your own screen, so you see what they’re pointing at without switching back to the call.</p>
  <div class="downloads">
    ${mac}
    ${windows}
  </div>
  <h2>How it works</h2>
  <ol>
    <li><div><b>Install Chalk Helper and open it.</b> It waits quietly in the background.</div></li>
    <li><div><b>Share your screen in a Chalk call.</b> Chalk offers to connect Helper.</div></li>
    <li><div><b>Click Allow in Helper.</b> Type the code Helper shows into Chalk. Then pick the screen you’re sharing in Helper, or choose <b>Follow captured window</b> if you’re sharing a window.</div></li>
    <li><div><b>Marks appear on your screen as people draw.</b> Others still see them on your share as usual.</div></li>
  </ol>
  <footer>Helper connects to a call only after you allow it, and you can disconnect it at any time.</footer>
</main>
</body>
</html>
`;
}
