import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DeveloperDTO } from "../../lib/dashboard/contracts";
import { errorMessage, readPage } from "../../lib/dashboard/client";
import { Icon, type IconName } from "../site/Icon";
import { Page } from "./Page";
import { Sk, useToast } from "./kit";

const SECTIONS: readonly { readonly id: string; readonly label: string; readonly icon: IconName }[] = [
  { id: "connect", label: "Connect", icon: "link" },
  { id: "keys", label: "API keys", icon: "key" },
  { id: "websites", label: "Websites", icon: "globe" },
  { id: "webhooks", label: "Webhooks", icon: "hook" },
  { id: "calls", label: "Calls", icon: "rec" },
  { id: "apps", label: "AI apps", icon: "grid" },
];

/** The page frame: the section nav beside the heading and the panels. */
export function Shell({ nav, children }: { readonly nav?: ReactNode; readonly children: ReactNode }) {
  return (
    <Page title="Developer" intro="API keys, allowed websites, webhooks and call settings for your app." nav={nav}>
      {children}
    </Page>
  );
}

/**
 * The section the reader is in: the last one whose top has passed the middle of the window, or the last section once the
 * page is scrolled to its end, where a short final section could never reach the middle. A jump link centres its target
 * and a nav click puts a section at the top, and both leave the section they name as the last one above the middle.
 * `choose` names the clicked section at once and holds scroll updates until the smooth scroll it starts has settled, so
 * the highlight doesn't run through every section on the way, and keeps it if the scroll brought it into view. It
 * recomputes on resize, which moves every section.
 */
function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState(ids[0] ?? "");
  const holding = useRef(false);
  const chosen = useRef("");
  const timer = useRef(0);
  const update = useCallback(() => {
    const atEnd = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const middle = window.innerHeight / 2 + 1;
    const passed = ids.filter((id) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= middle);
    setActive(atEnd ? (ids.at(-1) ?? "") : (passed.at(-1) ?? ids[0] ?? ""));
  }, [ids]);
  const release = useCallback(() => {
    window.clearTimeout(timer.current);
    holding.current = false;
    // A section the click brought into view stays the answer, even when the page ends before it can reach the middle.
    const top = document.getElementById(chosen.current)?.getBoundingClientRect().top;
    if (top !== undefined && top >= 0 && top < window.innerHeight) setActive(chosen.current);
    else update();
    chosen.current = "";
  }, [update]);
  // Browsers without `scrollend` settle when scroll events stop for a moment.
  const hold = useCallback(() => {
    holding.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(release, 150);
  }, [release]);
  useEffect(() => {
    const onScroll = () => (holding.current ? hold() : update());
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", release);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", release);
      window.removeEventListener("resize", update);
      window.clearTimeout(timer.current);
    };
  }, [update, release, hold]);
  const choose = (id: string) => {
    chosen.current = id;
    setActive(id);
    hold();
  };
  return [active, choose] as const;
}

const SECTION_IDS = SECTIONS.map((section) => section.id);

export function SectionNav({ soon, failing }: { readonly soon: boolean; readonly failing: boolean }) {
  const [active, choose] = useActiveSection(SECTION_IDS);
  return (
    <nav className="side" aria-label="On this page">
      <div className="cap">On this page</div>
      {SECTIONS.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={active === section.id ? "location" : undefined}
          onClick={(event) => {
            event.preventDefault();
            choose(section.id);
            document.getElementById(section.id)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          }}
        >
          <Icon name={section.icon} size={16} />
          {section.label}
          {section.id === "keys" && soon ? <span className="pip" title="A key expires soon" /> : null}
          {section.id === "webhooks" && failing ? <span className="pip bad" title="An endpoint is failing" /> : null}
        </a>
      ))}
    </nav>
  );
}

/** The page as it will look: the real nav, headings and labels, with only the values still to come drawn as bars. */
export function DeveloperSkeleton() {
  return (
    <Shell nav={<SectionNav soon={false} failing={false} />}>
      <div aria-busy="true" aria-label="Loading" className="dstack">
        {PANELS.map((panel) => (
          <section key={panel.title} className="panel card">
            <div className="ph">
              <Icon name={panel.icon} size={18} />
              <div>
                <h2>{panel.title}</h2>
                {panel.sub ? <div className="sub">{panel.sub}</div> : null}
              </div>
            </div>
            <div className="skbody">
              {Array.from({ length: panel.rows }, (_, index) => (
                <div key={index} className="skline">
                  <Sk width={index % 2 ? "38%" : "52%"} height={12} />
                  <Sk width="72px" height={12} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Shell>
  );
}

const PANELS: readonly { readonly icon: IconName; readonly title: string; readonly sub: string; readonly rows: number }[] = [
  { icon: "link", title: "Connect your app", sub: "Two values and a server. Browsers never get a key; they get an AccessGrant.", rows: 3 },
  { icon: "key", title: "API keys", sub: "", rows: 3 },
];

/** The first pages of keys can all be expired while a live key sits on a later page, so the Connect card keeps loading pages until it has one. */
export function LiveKeySearch({ cursor, onPage }: { readonly cursor: string; readonly onPage: (page: DeveloperDTO) => void }) {
  const toast = useToast();
  const latest = useRef({ onPage, toast });
  useEffect(() => {
    latest.current = { onPage, toast };
  });
  useEffect(() => {
    let current = true;
    readPage("developer", { keyCursor: cursor }).then(
      (page) => {
        if (current) latest.current.onPage(page);
      },
      (error: unknown) => latest.current.toast(errorMessage(error), { icon: "alert" }),
    );
    return () => {
      current = false;
    };
  }, [cursor]);
  return null;
}
