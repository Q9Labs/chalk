import { useId, useState } from "react";

import { Icon } from "../site/Icon";
import { AppLogo, AppPair } from "./AppLogo";
import { CopyAction, Dialog, Seg } from "./kit";

type Category = "chat" | "agent";

type Way = { readonly kind: "ready"; readonly copyLabel: string; readonly copy: (url: string) => string; readonly steps: readonly string[]; readonly note?: string } | { readonly kind: "soon"; readonly reason: string };

type Client = {
  readonly name: string;
  readonly category: Category;
  readonly line: string;
  /** Matches the name the app registered with Chalk, to show it as connected. */
  readonly registered: RegExp;
  readonly docs: string;
  readonly way: Way;
};

// A client is "ready" only after a real connect through its steps has worked against Chalk's OAuth.
const CLIENTS: readonly Client[] = [
  {
    name: "Claude",
    category: "chat",
    line: "Web and desktop app",
    registered: /^claude(?!\s*code)/i,
    docs: "https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers",
    way: {
      kind: "ready",
      copyLabel: "Chalk URL",
      copy: (url) => url,
      steps: ["Open Claude and go to Customize, then Connectors.", "Choose Add, then Add custom connector.", "Name it Chalk and paste the URL above.", "Choose Continue and sign in. Leave the OAuth client on Register automatically.", "Claude opens Chalk. Pick the access and approve."],
      note: "On Team and Enterprise plans an owner adds it first, in Organization settings under Connectors.",
    },
  },
  {
    name: "ChatGPT",
    category: "chat",
    line: "Custom connector",
    registered: /chatgpt/i,
    docs: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
    way: {
      kind: "ready",
      copyLabel: "Chalk URL",
      copy: (url) => url,
      steps: ["Open ChatGPT settings and go to Connectors. Under Advanced, turn on Developer mode.", "Create a connector, name it Chalk and paste the URL above.", "Choose OAuth for authentication.", "ChatGPT opens Chalk. Pick the access and approve."],
      note: "OpenAI renames these menus often. If a name differs, search its help center for custom connectors.",
    },
  },
  {
    name: "Grok",
    category: "chat",
    line: "Custom connector on grok.com",
    registered: /grok/i,
    docs: "https://docs.x.ai/grok/connectors",
    way: { kind: "soon", reason: "Chalk hasn’t been tested with Grok yet, so a connection could fail at the approval step." },
  },
  {
    name: "Claude Code",
    category: "agent",
    line: "Terminal agent",
    registered: /claude\s*code/i,
    docs: "https://code.claude.com/docs/en/mcp",
    way: {
      kind: "ready",
      copyLabel: "Command",
      copy: (url) => `claude mcp add --transport http chalk ${url}`,
      steps: ["Run the command in your terminal. Add --scope user to use Chalk in every project.", "Start Claude Code, run /mcp and choose chalk.", "Choose Authenticate. Your browser opens Chalk. Pick the access and approve."],
    },
  },
  {
    name: "Codex",
    category: "agent",
    line: "Terminal agent",
    registered: /codex/i,
    docs: "https://developers.openai.com/codex/mcp",
    way: {
      kind: "ready",
      copyLabel: "Command",
      copy: (url) => `codex mcp add chalk --url ${url}`,
      steps: ["Run the command in your terminal.", "Run codex mcp login chalk. Your browser opens Chalk. Pick the access and approve."],
      note: "On a machine without a browser, add --no-browser to the login command.",
    },
  },
  {
    name: "Gemini CLI",
    category: "agent",
    line: "Terminal agent",
    registered: /gemini/i,
    docs: "https://geminicli.com/docs/tools/mcp-server/",
    way: {
      kind: "ready",
      copyLabel: "settings.json",
      copy: (url) => JSON.stringify({ mcpServers: { chalk: { httpUrl: url, authProviderType: "dynamic_discovery", oauth: { enabled: true } } } }, null, 2),
      steps: ["Add this to ~/.gemini/settings.json. If the file already has mcpServers, add only the chalk entry.", "Start Gemini CLI and run /mcp auth chalk. Your browser opens Chalk. Pick the access and approve."],
    },
  },
  {
    name: "Devin",
    category: "agent",
    line: "Remote MCP server",
    registered: /devin|cognition/i,
    docs: "https://docs.devin.ai/work-with-devin/mcp",
    way: { kind: "soon", reason: "Chalk doesn’t accept Devin’s sign-in address yet." },
  },
];

const FILTERS = [
  ["all", "All"],
  ["chat", "Chat apps"],
  ["agent", "Coding agents"],
] as const;
type Filter = (typeof FILTERS)[number][0];

/** "Connect an AI app": every client with the fastest real way to add Chalk to it. */
export function McpClients({ mcpUrl, registeredNames }: { readonly mcpUrl: string; readonly registeredNames: readonly string[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Client | null>(null);
  const searchId = useId();

  const needle = query.trim().toLowerCase();
  const shown = CLIENTS.filter((client) => (filter === "all" || client.category === filter) && (!needle || client.name.toLowerCase().includes(needle)));

  return (
    <>
      <div className="cfind">
        <label className="cquery" htmlFor={searchId}>
          <Icon name="search" size={18} />
          <span className="sr">Search AI apps</span>
          <input id={searchId} className="inp" type="search" value={query} placeholder="Search AI apps" autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Seg label="Kind of app" options={FILTERS} value={filter} onChange={setFilter} small />
      </div>
      {shown.length === 0 ? (
        <p className="ohelp">No app matches “{query.trim()}”.</p>
      ) : (
        <ul className="cgrid">
          {shown.map((client) => {
            const connected = registeredNames.some((name) => client.registered.test(name));
            return (
              <li key={client.name}>
                <button type="button" className="ctile" onClick={() => setOpen(client)}>
                  <AppLogo name={client.name} size="md" />
                  <span className="ctext">
                    <span className="nm">{client.name}</span>
                    <span className="ln">{client.line}</span>
                  </span>
                  {connected ? (
                    <span className="cbadge ok">
                      <Icon name="check" size={12} />
                      Connected
                    </span>
                  ) : client.way.kind === "soon" ? (
                    <span className="cbadge">Soon</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open ? <ClientSheet client={open} mcpUrl={mcpUrl} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function ClientSheet({ client, mcpUrl, onClose }: { readonly client: Client; readonly mcpUrl: string; readonly onClose: () => void }) {
  const { way } = client;
  return (
    <Dialog
      wide
      tall={way.kind === "ready"}
      onClose={onClose}
      lead={<AppPair name={client.name} />}
      title={`Add Chalk to ${client.name}`}
      actions={
        <>
          <a className="btn gh" href={client.docs} target="_blank" rel="noopener noreferrer">
            {client.name} docs
          </a>
          <button type="button" className="btn pri" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {way.kind === "soon" ? (
        <p className="csoon">{way.reason} It will appear here once it works end to end.</p>
      ) : (
        <>
          <div className="cfield">
            <span className="lbl">{way.copyLabel}</span>
            <div className="cbox2">
              <code>{way.copy(mcpUrl)}</code>
              <CopyAction pill text={way.copy(mcpUrl)} label="Copy" toastMessage={`${way.copyLabel} copied`} />
            </div>
          </div>
          <ol className="csteps">
            {way.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {way.note ? <p className="cnote">{way.note}</p> : null}
        </>
      )}
    </Dialog>
  );
}
