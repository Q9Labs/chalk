import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import type { DeveloperDTO, KeyDTO, WebhookDTO } from "../../lib/dashboard/contracts";
import { dashboardWebsiteOrigin } from "../../lib/dashboard/contracts";
import { errorMessage, readPage } from "../../lib/dashboard/client";
import { ago, expiresSoon, hasExpired } from "../../lib/dashboard/format";
import { Icon, type IconName } from "../site/Icon";
import { AppLogo } from "./AppLogo";
import { useLoad } from "./AppShell";
import { ConnectPanel, type FreshSecret } from "./DeveloperConnect";
import { CallsPanel } from "./DeveloperCalls";
import { AddWebsiteDialog, CreateKeyDialog, EndpointDialog, RemoveWebsiteDialog, RevokeKeyDialog, RotateKeyDialog, RotateWebhookDialog, SecretDialog, type Secret } from "./DeveloperDialogs";
import { KeysPanel } from "./DeveloperKeys";
import { SitesPanel } from "./DeveloperSites";
import { isFailing, WebhooksPanel } from "./DeveloperWebhooks";
import { ErrorPanel, Sk, useToast } from "./kit";
import { useJumpTarget } from "./jump";
import { Page, Stat } from "./Page";

type Open =
  | null
  | { readonly kind: "create-key" }
  | { readonly kind: "rotate-key" | "revoke-key"; readonly apiKey: KeyDTO }
  | { readonly kind: "add-endpoint" }
  | { readonly kind: "rotate-webhook" | "edit-endpoint"; readonly webhook: WebhookDTO }
  | { readonly kind: "add-website" }
  | { readonly kind: "remove-website"; readonly origin: string }
  | { readonly kind: "secret"; readonly secret: Secret };

const SECTIONS: readonly { readonly id: string; readonly label: string; readonly icon: IconName }[] = [
  { id: "connect", label: "Connect", icon: "link" },
  { id: "keys", label: "API keys", icon: "key" },
  { id: "websites", label: "Websites", icon: "globe" },
  { id: "webhooks", label: "Webhooks", icon: "hook" },
  { id: "calls", label: "Calls", icon: "rec" },
  { id: "apps", label: "AI apps", icon: "grid" },
];

export function DeveloperPage() {
  const { state, reload, update } = useLoad(() => readPage("developer", {}), "developer");
  const [open, setOpen] = useState<Open>(null);
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined);
  // The full secret of a key just made or rotated. It lives only here, in memory, until the page closes.
  const [fresh, setFresh] = useState<FreshSecret | null>(null);
  const toast = useToast();
  const close = () => setOpen(null);
  useJumpTarget(state.kind === "ready");

  if (state.kind === "loading") return <DeveloperSkeleton />;
  if (state.kind === "error")
    return (
      <Shell>
        <ErrorPanel title="Couldn’t load your developer settings" detail={errorMessage(state.error)} onRetry={reload} />
      </Shell>
    );

  const data = state.data;
  const listed = data.keys.filter((key) => !key.revokedAt);
  // Expired keys stay in the table so they can be rotated or revoked, but they are not usable, so they are not counted or offered for the snippets.
  const keys = listed.filter((key) => !hasExpired(key.expiresAt));
  const origins = data.allowedWebsites.filter((origin) => origin !== dashboardWebsiteOrigin);
  const opened = expanded === undefined ? (data.webhooks[0]?.id ?? null) : expanded;
  const setWebsites = (allowedWebsites: readonly string[]) => update((value): DeveloperDTO => ({ ...value, allowedWebsites }));
  const soon = keys.filter((key) => expiresSoon(key.expiresAt));
  const failing = data.webhooks.filter(isFailing);

  /** Re-reads the first page of keys in place, since a full reload would unmount the button a dialog returns focus to. Gives back the key whose secret this is. */
  async function refreshKeys(secret: string, fallbackId: string | null): Promise<string | null> {
    try {
      const page = await readPage("developer", {});
      update((value) => ({ ...value, keys: page.keys, nextKeyCursor: page.nextKeyCursor }));
      return page.keys.find((key) => secret.startsWith(key.prefix))?.id ?? fallbackId;
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
      return fallbackId;
    }
  }
  function showSecret(secret: Secret, fallbackId: string | null) {
    setOpen({ kind: "secret", secret });
    if (secret.kind === "key") void refreshKeys(secret.secret, fallbackId).then((keyId) => setFresh({ secret: secret.secret, keyId }));
  }

  return (
    <Shell nav={<SectionNav soon={soon.length > 0} failing={failing.length > 0} />}>
      <Summary keys={keys} used={listed} moreKeys={data.nextKeyCursor !== null} soon={soon} websites={origins.length + 1} webhooks={data.webhooks} moreWebhooks={data.nextWebhookCursor !== null} failing={failing.length} />
      {keys.length === 0 && data.nextKeyCursor ? <LiveKeySearch cursor={data.nextKeyCursor} onPage={(page) => update((value) => ({ ...value, keys: [...value.keys, ...page.keys], nextKeyCursor: page.nextKeyCursor }))} /> : null}
      <ConnectPanel tenantId={data.tenantId} keys={keys} fresh={fresh} onCreateKey={() => setOpen({ kind: "create-key" })} />
      <KeysPanel
        keys={listed}
        nextCursor={data.nextKeyCursor}
        fresh={fresh}
        onCreate={() => setOpen({ kind: "create-key" })}
        onRotate={(apiKey) => setOpen({ kind: "rotate-key", apiKey })}
        onRevoke={(apiKey) => setOpen({ kind: "revoke-key", apiKey })}
        onMore={(page) => update((value) => ({ ...value, keys: [...value.keys, ...page.keys], nextKeyCursor: page.nextKeyCursor }))}
      />
      <SitesPanel origins={origins} onAdd={() => setOpen({ kind: "add-website" })} onRemove={(origin) => setOpen({ kind: "remove-website", origin })} />
      <WebhooksPanel
        webhooks={data.webhooks}
        nextCursor={data.nextWebhookCursor}
        opened={opened}
        onToggle={(id) => setExpanded(opened === id ? null : id)}
        onAdd={() => setOpen({ kind: "add-endpoint" })}
        onRotate={(webhook) => setOpen({ kind: "rotate-webhook", webhook })}
        onEdit={(webhook) => setOpen({ kind: "edit-endpoint", webhook })}
        onMore={(page) => update((value) => ({ ...value, webhooks: [...value.webhooks, ...page.webhooks], nextWebhookCursor: page.nextWebhookCursor }))}
      />
      <CallsPanel renderMode={data.recordingRenderMode} language={data.transcriptLanguage ?? "auto"} onRenderMode={(recordingRenderMode) => update((value) => ({ ...value, recordingRenderMode }))} onLanguage={(transcriptLanguage) => update((value) => ({ ...value, transcriptLanguage }))} />
      <section className="panel card" id="apps" aria-labelledby="apps-title">
        <div className="apps">
          <span className="marks">
            <AppLogo name="Claude" size="sm" />
            <AppLogo name="ChatGPT" size="sm" />
          </span>
          <div className="tx">
            <b id="apps-title">AI apps</b>
            <span className="mu">Let Claude, ChatGPT and other AI apps use Chalk for you.</span>
          </div>
          <Link className="btn out" to="/dashboard/apps">
            Connect an AI app
            <Icon name="arrowR" size={16} />
          </Link>
        </div>
      </section>

      {open?.kind === "create-key" ? <CreateKeyDialog onClose={close} onCreated={(secret) => showSecret({ kind: "key", secret }, null)} /> : null}
      {open?.kind === "rotate-key" ? <RotateKeyDialog apiKey={open.apiKey} onClose={close} onRotated={(secret) => showSecret({ kind: "key", secret, rotated: { name: open.apiKey.name, stoppedOld: true } }, open.apiKey.id)} /> : null}
      {open?.kind === "revoke-key" ? (
        <RevokeKeyDialog
          apiKey={open.apiKey}
          onClose={close}
          onRevoked={() => {
            update((value) => ({ ...value, keys: value.keys.filter((key) => key.id !== open.apiKey.id) }));
            close();
          }}
        />
      ) : null}
      {open?.kind === "add-endpoint" ? (
        <EndpointDialog
          onClose={close}
          onCreated={(webhook, secret) => {
            update((value) => ({ ...value, webhooks: [...value.webhooks, webhook] }));
            setExpanded(webhook.id);
            setOpen({ kind: "secret", secret: { kind: "webhook", secret } });
          }}
        />
      ) : null}
      {open?.kind === "edit-endpoint" ? (
        <EndpointDialog
          webhook={open.webhook}
          onClose={close}
          onSaved={(saved) => {
            // The save returns the endpoint without its last delivery; keep the one the list had.
            update((value) => ({ ...value, webhooks: value.webhooks.map((item) => (item.id === saved.id ? { ...saved, lastDelivery: item.lastDelivery } : item)) }));
            close();
            toast(`Saved the events for ${saved.name}`);
          }}
        />
      ) : null}
      {open?.kind === "rotate-webhook" ? <RotateWebhookDialog webhook={open.webhook} onClose={close} onRotated={(secret, stoppedOld) => setOpen({ kind: "secret", secret: { kind: "webhook", secret, rotated: { name: open.webhook.name, stoppedOld } } })} /> : null}
      {open?.kind === "add-website" ? (
        <AddWebsiteDialog
          origins={origins}
          onClose={close}
          onSaved={(allowedWebsites, added) => {
            setWebsites(allowedWebsites);
            close();
            toast(`Added ${added}`);
          }}
        />
      ) : null}
      {open?.kind === "remove-website" ? (
        <RemoveWebsiteDialog
          origin={open.origin}
          origins={origins}
          onClose={close}
          onSaved={(allowedWebsites) => {
            setWebsites(allowedWebsites);
            close();
          }}
        />
      ) : null}
      {open?.kind === "secret" ? <SecretDialog secret={open.secret} onClose={close} /> : null}
    </Shell>
  );
}

/** The page frame: the section nav beside the heading and the panels. */
function Shell({ nav, children }: { readonly nav?: ReactNode; readonly children: ReactNode }) {
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

function SectionNav({ soon, failing }: { readonly soon: boolean; readonly failing: boolean }) {
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
function DeveloperSkeleton() {
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
function Summary({
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
function LiveKeySearch({ cursor, onPage }: { readonly cursor: string; readonly onPage: (page: DeveloperDTO) => void }) {
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
