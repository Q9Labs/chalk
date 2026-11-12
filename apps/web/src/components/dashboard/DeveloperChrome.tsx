import { useEffect, useState, type ReactNode } from "react";
import type { DeveloperDTO, KeyDTO, WebhookDTO } from "../../lib/dashboard/contracts";
import { errorMessage, readPage } from "../../lib/dashboard/client";
import { ago, expiresSoon } from "../../lib/dashboard/format";
import { Icon, type IconName } from "../site/Icon";
import { Page, Stat } from "./Page";
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
    <Page
      icon="code"
      title="Developer"
      intro="API keys, allowed websites, webhooks and call settings for your app. A call is a Space; one session is an Episode, as in the API."
      nav={nav}
      end={
        <a className="btn out end" href="/docs">
          <Icon name="book" size={16} />
          Read the docs
        </a>
      }
    >
      {children}
    </Page>
  );
}

/** The section the reader is in: the last one whose top has passed the top bar. */
function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const update = () => {
      const passed = ids.filter((id) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= 120);
      setActive(passed.at(-1) ?? ids[0] ?? "");
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [ids]);
  return [active, setActive] as const;
}

const SECTION_IDS = SECTIONS.map((section) => section.id);

export function SectionNav({ soon, failing }: { readonly soon: boolean; readonly failing: boolean }) {
  const [active, setActive] = useActiveSection(SECTION_IDS);
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
            setActive(section.id);
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
        <div className="card stats">
          {STAT_LABELS.map(([icon, label]) => (
            <Stat key={label} icon={icon} label={label} value={<Sk width="48px" height={24} />}>
              <Sk width="96px" height={12} />
            </Stat>
          ))}
        </div>
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

const STAT_LABELS: readonly (readonly [IconName, string])[] = [
  ["key", "Active API keys"],
  ["clock", "Last key use"],
  ["globe", "Allowed websites"],
  ["hook", "Webhook endpoints"],
];

const PANELS: readonly { readonly icon: IconName; readonly title: string; readonly sub: string; readonly rows: number }[] = [
  { icon: "link", title: "Connect your app", sub: "Two values and a server. Browsers never get a key; they get an AccessGrant.", rows: 3 },
  { icon: "key", title: "API keys", sub: "", rows: 3 },
];

/** Four numbers the page really has: it never invents usage the API doesn't return. */
export function Summary({
  keys,
  used,
  moreKeys,
  soon,
  websites,
  webhooks,
  moreWebhooks,
  failing,
}: {
  readonly keys: readonly KeyDTO[];
  readonly used: readonly KeyDTO[];
  readonly moreKeys: boolean;
  readonly soon: readonly KeyDTO[];
  readonly websites: number;
  readonly webhooks: readonly WebhookDTO[];
  readonly moreWebhooks: boolean;
  readonly failing: number;
}) {
  const lastUsed = used.reduce<KeyDTO | null>((latest, key) => (key.lastUsedAt && (!latest?.lastUsedAt || key.lastUsedAt > latest.lastUsedAt) ? key : latest), null);
  const soonest = soon[0];
  return (
    <div className="card stats" role="group" aria-label="Summary">
      <Stat icon="key" label="Active API keys" value={`${keys.length}${moreKeys ? "+" : ""}`}>
        {!keys.length ? (
          "Create one to start"
        ) : soonest ? (
          <span className="pill warn">
            <Icon name="clock" size={12} />
            {soon.length === 1 ? `1 expires ${expiresSoon(soonest.expiresAt)}` : `${soon.length} expire this week`}
          </span>
        ) : (
          "None expiring soon"
        )}
      </Stat>
      <Stat icon="clock" label="Last key use" value={lastUsed?.lastUsedAt ? ago(lastUsed.lastUsedAt) : "–"}>
        {lastUsed ? <span className="ell">{lastUsed.name}</span> : "No calls yet"}
      </Stat>
      <Stat icon="globe" label="Allowed websites" value={String(websites)}>
        1 always allowed
      </Stat>
      <Stat icon="hook" label="Webhook endpoints" value={`${webhooks.length}${moreWebhooks ? "+" : ""}`}>
        {failing ? (
          <span className="pill bad">
            <span className="d" />
            {failing} failing
          </span>
        ) : webhooks.length ? (
          "No failures"
        ) : (
          "None yet"
        )}
      </Stat>
    </div>
  );
}

/** The first pages of keys can all be expired while a live key sits on a later page, so the Connect card keeps loading pages until it has one. */
export function LiveKeySearch({ cursor, onPage }: { readonly cursor: string; readonly onPage: (page: DeveloperDTO) => void }) {
  const toast = useToast();
  useEffect(() => {
    let current = true;
    readPage("developer", { keyCursor: cursor }).then(
      (page) => {
        if (current) onPage(page);
      },
      (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cursor alone names the page to fetch; onPage and toast are new on every render
  }, [cursor]);
  return null;
}

