import { type LegalDocument, slugifyLegalSection } from "./legalDocuments";

const staticPageStyles = `
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    --bg: #ffffff;
    --bg-subtle: #fafafa;
    --border: rgba(0, 0, 0, 0.1);
    --border-subtle: rgba(0, 0, 0, 0.06);
    --text: #18181b;
    --text-heading: #09090b;
    --text-muted: #71717a;
    --text-faint: #a1a1aa;
    --text-link: #3f3f46;
    --link-underline: #d4d4d8;
    --toc-active: #18181b;
    --toc-inactive: #71717a;
    --toc-num: #d4d4d8;
    --footer-border: rgba(0, 0, 0, 0.06);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #030303;
      --bg-subtle: rgba(255, 255, 255, 0.02);
      --border: rgba(255, 255, 255, 0.1);
      --border-subtle: rgba(255, 255, 255, 0.06);
      --text: #f4f4f5;
      --text-heading: #fafafa;
      --text-muted: #a1a1aa;
      --text-faint: #52525b;
      --text-link: #d4d4d8;
      --link-underline: rgba(255, 255, 255, 0.15);
      --toc-active: #f4f4f5;
      --toc-inactive: #a1a1aa;
      --toc-num: #52525b;
      --footer-border: rgba(255, 255, 255, 0.06);
    }
  }

  html {
    color-scheme: light dark;
  }

  body {
    margin: 0;
    min-height: 100vh;
    font-family:
      Inter,
      ui-sans-serif,
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    letter-spacing: -0.01em;
  }

  /* Header */
  .header {
    position: sticky;
    top: 0;
    z-index: 50;
    border-bottom: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg) 80%, transparent);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .header-inner {
    max-width: 1024px;
    margin: 0 auto;
    padding: 0 24px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 24px;
  }

  .header-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-heading);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-left: 16px;
    border-left: 1px solid var(--border-subtle);
  }

  .header-link {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-faint);
    text-decoration: none;
  }

  .header-link:hover {
    color: var(--text-muted);
  }

  /* Main content */
  .main {
    max-width: 768px;
    margin: 0 auto;
    padding: 48px 24px 80px;
  }

  h1 {
    font-size: clamp(1.875rem, 4vw, 2.25rem);
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--text-heading);
    margin: 0 0 8px;
  }

  .meta {
    font-size: 14px;
    color: var(--text-faint);
    margin: 0 0 40px;
  }

  /* ToC */
  .toc {
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--bg-subtle);
    padding: 20px 24px;
    margin-bottom: 48px;
  }

  .toc-heading {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-faint);
    margin: 0 0 12px;
  }

  .toc ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .toc li + li {
    margin-top: 8px;
  }

  .toc a {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: var(--toc-inactive);
    text-decoration: none;
  }

  .toc a:hover {
    color: var(--text);
  }

  .toc .toc-num {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--toc-num);
    min-width: 1.5em;
  }

  /* Sections */
  .intro {
    margin-bottom: 32px;
  }

  .sections {
    display: flex;
    flex-direction: column;
    gap: 40px;
  }

  section {
    scroll-margin-top: 96px;
  }

  h2 {
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-heading);
    margin: 0 0 16px;
  }

  p, li {
    color: var(--text-muted);
    font-size: 1rem;
    line-height: 1.7;
  }

  strong {
    color: var(--text);
  }

  ul {
    padding-left: 24px;
  }

  ul li + li {
    margin-top: 10px;
  }

  a {
    color: var(--text-link);
    text-decoration: underline;
    text-underline-offset: 2px;
    text-decoration-color: var(--link-underline);
  }

  a:hover {
    text-decoration-color: var(--text-muted);
  }

  /* Cross-page link */
  .cross-page {
    margin-top: 64px;
    padding-top: 32px;
    border-top: 1px solid var(--border);
  }

  .cross-page p {
    font-size: 14px;
    color: var(--text-faint);
  }

  /* Footer */
  .footer {
    border-top: 1px solid var(--footer-border);
    padding: 48px 24px;
  }

  .footer-inner {
    max-width: 1024px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 32px;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-faint);
  }

  .footer-nav {
    display: flex;
    gap: 24px;
    font-size: 14px;
    font-weight: 500;
  }

  .footer-nav a {
    color: var(--text-faint);
    text-decoration: none;
  }

  .footer-nav a:hover {
    color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .footer-inner {
      flex-direction: column;
      text-align: center;
    }
  }
`.trim();

function renderToC(doc: LegalDocument): string {
  const items = doc.sections
    .map((section, i) => {
      const id = slugifyLegalSection(section.title);
      return `          <li><a href="#${id}"><span class="toc-num">${i + 1}.</span>${section.title}</a></li>`;
    })
    .join("\n");

  return `      <nav class="toc" aria-label="Table of contents">
        <div class="toc-heading">Contents</div>
        <ol>
${items}
        </ol>
      </nav>`;
}

function renderSections(doc: LegalDocument): string {
  return doc.sections
    .map((section) => {
      const id = slugifyLegalSection(section.title);
      return `      <section id="${id}">
        <h2>${section.title}</h2>
        ${section.bodyHtml}
      </section>`;
    })
    .join("\n\n");
}

export function renderStaticLegalPage(doc: LegalDocument): string {
  const isPrivacy = doc.slug === "privacy";
  const otherLabel = isPrivacy ? "Terms of Service" : "Privacy Policy";
  const otherHref = isPrivacy ? "/terms" : "/privacy";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chalk ${doc.title}</title>
    <link rel="canonical" href="https://chalkmeet.com/${doc.slug}" />
    <style>
      ${staticPageStyles}
    </style>
  </head>
  <body>
    <header class="header">
      <div class="header-inner">
        <div class="header-left">
          <span style="font-weight:700;color:var(--text-heading)">Chalk</span>
          <span class="header-title">${doc.title}</span>
        </div>
        <div class="header-right">
          <a href="${otherHref}" class="header-link">${otherLabel}</a>
        </div>
      </div>
    </header>

    <main class="main">
      <h1>${doc.title}</h1>
      <p class="meta">Last updated: ${doc.lastUpdated}</p>

${renderToC(doc)}

      <div class="intro">
        ${doc.introHtml}
      </div>

      <div class="sections">
${renderSections(doc)}
      </div>

      <div class="cross-page">
        <p>Also see our <a href="${otherHref}">${otherLabel}</a>.</p>
      </div>
    </main>

    <footer class="footer">
      <div class="footer-inner">
        <div class="footer-left">
          <span>&copy; ${new Date().getFullYear()} Chalk</span>
        </div>
        <nav class="footer-nav">
          <a href="/">Home</a>
          <a href="mailto:support@example.com">Support</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </div>
    </footer>
  </body>
</html>
`;
}

export function renderLegacyPrivacyPolicyRedirectPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=/privacy" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chalk Privacy Policy</title>
    <link rel="canonical" href="https://chalkmeet.com/privacy" />
  </head>
  <body>
    <p>Redirecting to <a href="/privacy">Chalk Privacy Policy</a>...</p>
  </body>
</html>
`;
}
