import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import DashboardSquare01Icon from "@hugeicons/core-free-icons/DashboardSquare01Icon";
import DoorIcon from "@hugeicons/core-free-icons/DoorIcon";
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon";

import { Icon } from "./Icon";
import { SpaceLinkCard } from "./visuals";

type CodeTone = "keyword" | "string" | "type" | "call" | "comment";
type CodeToken = { readonly id: string; readonly text: string; readonly tone?: CodeTone };
type CodeLine = { readonly id: string; readonly tokens: readonly CodeToken[] };

const SDK_SAMPLE: readonly CodeLine[] = [
  {
    id: "import",
    tokens: [
      { id: "kw", text: "import", tone: "keyword" },
      { id: "open", text: " { " },
      { id: "name", text: "Chalk", tone: "type" },
      { id: "close", text: " } " },
      { id: "from", text: "from", tone: "keyword" },
      { id: "space", text: " " },
      { id: "pkg", text: '"@q9labsai/chalk-react"', tone: "string" },
      { id: "end", text: ";" },
    ],
  },
  { id: "gap-1", tokens: [] },
  {
    id: "signature",
    tokens: [
      { id: "export", text: "export", tone: "keyword" },
      { id: "space-1", text: " " },
      { id: "function", text: "function", tone: "keyword" },
      { id: "space-2", text: " " },
      { id: "name", text: "DesignReview", tone: "call" },
      { id: "open", text: "() {" },
    ],
  },
  // One prop per line. The longest line here is what decides whether the block
  // scrolls sideways on a phone, so the element is broken the way a formatter
  // would break it rather than kept on one line for the desktop column.
  {
    id: "return",
    tokens: [
      { id: "indent", text: "  " },
      { id: "keyword", text: "return", tone: "keyword" },
      { id: "paren", text: " (" },
    ],
  },
  {
    id: "open-tag",
    tokens: [
      { id: "indent", text: "    <" },
      { id: "tag", text: "Chalk", tone: "type" },
    ],
  },
  {
    id: "prop-space",
    tokens: [
      { id: "indent", text: "      space=" },
      { id: "slug", text: '"design-lab"', tone: "string" },
    ],
  },
  { id: "prop-access", tokens: [{ id: "indent", text: "      getAccess={requestGrant}" }] },
  { id: "close-tag", tokens: [{ id: "indent", text: "    />" }] },
  { id: "close-return", tokens: [{ id: "paren", text: "  );" }] },
  { id: "close", tokens: [{ id: "brace", text: "}" }] },
  { id: "gap-2", tokens: [] },
  {
    id: "note-server",
    tokens: [{ id: "comment", text: "// requestGrant asks your server.", tone: "comment" }],
  },
  {
    id: "note-browser",
    tokens: [{ id: "comment", text: "// Browser code never mints access.", tone: "comment" }],
  },
];

function CodeSample() {
  return (
    <pre className="door-code" aria-label="Rendering a Chalk Space with the React SDK">
      <code>
        {SDK_SAMPLE.map((line) => (
          <span className="door-code-line" key={line.id}>
            {line.tokens.map((token) => (
              <span className={token.tone ? `tok tok-${token.tone}` : undefined} key={token.id}>
                {token.text}
              </span>
            ))}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function FrontDoors() {
  return (
    <section className="band" id="product">
      <div className="container">
        <header className="sec-head">
          <span className="eyebrow">
            <Icon glyph={DoorIcon} size={15} weight={2} />
            Two ways in
          </span>
          <h2>
            Sign in, <span className="muted">or npm install.</span>
          </h2>
          <p>Both doors open onto the same Space and Episode model, so nothing you learn on one side is wasted on the other.</p>
        </header>

        {/* Both cards put their sentence first and their artifact second, on
            shared rows, so the two are read as a comparison. Staggered, they
            just look misaligned. */}
        <div className="bento">
          <article className="bento-card card">
            <span className="bento-label">
              <Icon glyph={DashboardSquare01Icon} size={16} weight={2} />
              Use Chalk
            </span>
            <div className="bento-copy">
              <h3>Open a Space and send one link.</h3> <p>Create it from the dashboard, invite people by link, admit them with roles you control. The chat, the whiteboard, and the files are still there tomorrow.</p>
            </div>
            <div className="bento-actions">
              <a href="/sign-up" className="btn btn-primary">
                Create an account
                <Icon glyph={ArrowRight02Icon} size={16} weight={2.2} />
              </a>
              <a href="/home" className="btn btn-secondary">
                Open the dashboard
              </a>
            </div>
            <div className="bento-art">
              <SpaceLinkCard />
            </div>
          </article>

          <article className="bento-card card">
            <span className="bento-label">
              <Icon glyph={SourceCodeIcon} size={16} weight={2} />
              Build on Chalk
            </span>
            <div className="bento-copy">
              <h3>Drop a Space into your own product.</h3> <p>One component renders the whole surface. When you want a different shape, the same client gives you hooks for participants, chat, media, and capabilities.</p>
            </div>
            <div className="bento-actions">
              <a href="/sdk-preview" className="btn btn-primary">
                Explore the SDK
                <Icon glyph={ArrowRight02Icon} size={16} weight={2.2} />
              </a>
            </div>
            <div className="bento-art">
              <CodeSample />
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
