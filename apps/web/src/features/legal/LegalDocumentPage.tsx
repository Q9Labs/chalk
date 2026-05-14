import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChalkLogo } from "../../components/ChalkLogo";
import { useTheme } from "../../context/theme";
import { type LegalDocument, slugifyLegalSection } from "./legalDocuments";

export function LegalDocumentPage({ document: doc }: { document: LegalDocument }) {
  const { theme, toggleTheme } = useTheme();
  const [activeSection, setActiveSection] = useState<string | null>(null);

  const isPrivacy = doc.slug === "privacy";
  const otherLabel = isPrivacy ? "Terms of Service" : "Privacy Policy";
  const otherHref = isPrivacy ? "/terms" : "/privacy";

  // Track which section is in view for ToC highlighting
  useEffect(() => {
    const sectionIds = doc.sections.map((s) => slugifyLegalSection(s.title));
    if (sectionIds.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );

    for (const id of sectionIds) {
      const el = window.document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [doc]);

  return (
    <div className="font-app min-h-screen bg-white dark:bg-[#030303] text-zinc-900 dark:text-zinc-100 antialiased tracking-tight">
      {/* Header — matches status page */}
      <header className="sticky top-0 z-50 w-full border-b border-zinc-200/40 dark:border-white/[0.06] bg-white/80 dark:bg-[#030303]/80 backdrop-blur-xl supports-[backdrop-filter]:bg-white/60 dark:supports-[backdrop-filter]:bg-[#030303]/60">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link to="/" className="hover:opacity-80 transition-opacity">
              <ChalkLogo />
            </Link>
            <nav className="flex items-center gap-4 text-sm font-medium tracking-tight">
              <span className="text-zinc-900 dark:text-zinc-100 font-semibold">
                {doc.title}
              </span>
            </nav>
          </div>
          <div className="flex items-center gap-3 pl-2 md:pl-4 md:border-l border-zinc-200/50 dark:border-white/[0.06]">
            <Link
              to={otherHref}
              className="text-xs font-medium text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              {otherLabel}
            </Link>
            <div className="w-px h-4 bg-zinc-200 dark:bg-white/[0.08]" />
            <button
              type="button"
              onClick={toggleTheme}
              className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 rounded-full hover:bg-zinc-50 dark:hover:bg-white/[0.04] transition-colors"
              aria-label="Toggle theme"
            >
              <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12 md:py-20">
        {/* Title block */}
        <div className="mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {doc.title}
          </h1>
          <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
            Last updated: {doc.lastUpdated}
          </p>
        </div>

        {/* Inline Table of Contents */}
        <nav className="mb-12 rounded-2xl border border-zinc-200/80 dark:border-white/[0.08] bg-zinc-50/50 dark:bg-white/[0.02] px-6 py-5" aria-label="Table of contents">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-3">
            Contents
          </h2>
          <ol className="space-y-2">
            {doc.sections.map((section, i) => {
              const id = slugifyLegalSection(section.title);
              const isActive = activeSection === id;
              return (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className={`group flex items-center gap-2 text-sm transition-colors ${
                      isActive
                        ? "text-zinc-900 dark:text-zinc-100 font-medium"
                        : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                    }`}
                  >
                    <span className={`tabular-nums text-[11px] ${isActive ? "text-zinc-400 dark:text-zinc-500" : "text-zinc-300 dark:text-zinc-600"}`}>
                      {i + 1}.
                    </span>
                    {section.title}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Intro */}
        <div
          className="mb-8 [&_a]:text-zinc-700 dark:[&_a]:text-zinc-300 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-zinc-300 dark:[&_a]:decoration-zinc-600 [&_a]:hover:decoration-zinc-500 dark:[&_a]:hover:decoration-zinc-400 [&_p]:text-zinc-500 dark:[&_p]:text-zinc-400 [&_p]:leading-relaxed"
          dangerouslySetInnerHTML={{ __html: doc.introHtml }}
        />

        {/* Sections */}
        <div className="space-y-10">
          {doc.sections.map((section) => {
            const id = slugifyLegalSection(section.title);
            return (
              <section key={id} id={id} className="scroll-mt-24">
                <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 mb-4">
                  {section.title}
                </h2>
                <div
                  className="[&_a]:text-zinc-700 dark:[&_a]:text-zinc-300 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-zinc-300 dark:[&_a]:decoration-zinc-600 [&_a]:hover:decoration-zinc-500 dark:[&_a]:hover:decoration-zinc-400 [&_li]:text-zinc-500 dark:[&_li]:text-zinc-400 [&_li]:leading-relaxed [&_p]:text-zinc-500 dark:[&_p]:text-zinc-400 [&_p]:leading-relaxed [&_strong]:text-zinc-800 dark:[&_strong]:text-zinc-200 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-2.5"
                  dangerouslySetInnerHTML={{ __html: section.bodyHtml }}
                />
              </section>
            );
          })}
        </div>

        {/* Cross-page link */}
        <div className="mt-16 pt-8 border-t border-zinc-200/80 dark:border-white/[0.06]">
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            Also see our{" "}
            <Link
              to={otherHref}
              className="text-zinc-700 dark:text-zinc-300 underline underline-offset-2 decoration-zinc-300 dark:decoration-zinc-600 hover:decoration-zinc-500 dark:hover:decoration-zinc-400 transition-colors"
            >
              {otherLabel}
            </Link>
            .
          </p>
        </div>
      </main>

      {/* Footer — matches status page */}
      <footer className="py-12 border-t border-zinc-200/40 dark:border-white/[0.06] bg-white dark:bg-[#030303] relative z-10">
        <div className="mx-auto flex max-w-5xl flex-col md:flex-row justify-between items-center gap-8 px-6">
          <div className="flex items-center gap-3 text-sm text-zinc-400 dark:text-zinc-500 font-medium">
            <ChalkLogo className="h-5 w-auto grayscale opacity-40" />
            <span>© {new Date().getFullYear()} Chalk</span>
          </div>
          <nav className="flex gap-6 md:gap-8 text-sm font-medium text-zinc-400 dark:text-zinc-500">
            <Link to="/" className="hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">
              Home
            </Link>
            <a href="mailto:support@example.com" className="hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">
              Support
            </a>
            <a href="/privacy" className="hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">
              Privacy
            </a>
            <a href="/terms" className="hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">
              Terms
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
