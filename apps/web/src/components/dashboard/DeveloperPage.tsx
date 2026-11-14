import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { SITE_ORIGIN } from "../../lib/site-origin";
import { errorMessage, readPage } from "../../lib/dashboard/client";
import { expiresSoon, hasExpired } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { AppLogo } from "./AppLogo";
import { useLoad, type Update } from "./use-dashboard";
import type { DeveloperDTO } from "../../lib/dashboard/contracts";
import { ConnectPanel, type FreshSecret } from "./DeveloperConnect";
import { CallsPanel } from "./DeveloperCalls";
import { DeveloperSkeleton, LiveKeySearch, SectionNav, Shell, Summary } from "./DeveloperChrome";
import { DeveloperDialogs, type OpenDialog } from "./DeveloperDialogs";
import type { Secret } from "./developer-dialog-parts";
import { KeysPanel } from "./DeveloperKeys";
import { SitesPanel } from "./DeveloperSites";
import { isFailing, WebhooksPanel } from "./DeveloperWebhooks";
import { ErrorPanel, useToast } from "./kit";
import { useJumpTarget } from "./jump";

/** Opens the secret dialog, and for a key reads the first page again so the table shows it, then remembers which row it is. */
function useShowSecret(update: Update<DeveloperDTO>, setOpen: (open: OpenDialog) => void, setFresh: (fresh: FreshSecret) => void) {
  const toast = useToast();
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
  return showSecret;
}

export function DeveloperPage() {
  const { state, reload, update } = useLoad(() => readPage("developer", {}), "developer");
  const [open, setOpen] = useState<OpenDialog | null>(null);
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined);
  // The full secret of a key just made or rotated. It lives only here, in memory, until the page closes.
  const [fresh, setFresh] = useState<FreshSecret | null>(null);
  const showSecret = useShowSecret(update, setOpen, setFresh);
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
  const origins = data.allowedWebsites.filter((origin) => origin !== SITE_ORIGIN);
  const opened = expanded === undefined ? (data.webhooks[0]?.id ?? null) : expanded;
  const soon = keys.filter((key) => expiresSoon(key.expiresAt));
  const failing = data.webhooks.filter(isFailing);

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
      <AppsPanel />
      <DeveloperDialogs open={open} origins={origins} onOpen={setOpen} update={update} onExpandWebhook={setExpanded} showSecret={showSecret} />
    </Shell>
  );
}

function AppsPanel() {
  return (
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
  );
}
