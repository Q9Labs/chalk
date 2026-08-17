import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import type { CSSProperties } from "react";

import { Icon } from "./Icon";

// Coded visuals. Everything here is decoration for a claim made in prose next to
// it, so the whole layer is hidden from assistive technology.

const LAYERS = [
  { tier: "Front doors", nodes: ["Chalk app", "your app"], seam: false },
  { tier: "Portable core", nodes: ["api", "sync", "identity"], seam: false },
  { tier: "Contracts", nodes: ["MediaPlane", "TokenSigner"], seam: true },
  { tier: "Your infra", nodes: ["postgres", "an SFU"], seam: false },
] as const;

export function StackVisual() {
  return (
    <div className="sd" aria-hidden="true">
      {LAYERS.map((layer) => (
        <div className={layer.seam ? "sd-layer sd-layer-seam" : "sd-layer"} key={layer.tier}>
          {/* The note belongs to the seam, so it hangs off the seam's own row
              rather than floating somewhere in the drawing. */}
          {layer.seam ? (
            <span className="sd-annotation">
              swap either one
              <Icon glyph={ArrowRight02Icon} size={13} weight={2.4} />
            </span>
          ) : null}
          <span className="sd-tier">{layer.tier}</span>
          <span className="sd-nodes">
            {layer.nodes.map((node) => (
              <span className="sd-node" key={node}>
                {node}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

// Episodes are laid out on a 100-column track so the rail reads as elapsed time
// rather than as an evenly spaced list.
type TimelineEpisode = {
  readonly name: string;
  readonly meta: string;
  readonly start: number;
  readonly span: number;
  readonly artifacts: readonly string[];
  readonly live: boolean;
};

const EPISODES: readonly TimelineEpisode[] = [
  { name: "Kickoff", meta: "42 min", start: 1, span: 15, artifacts: ["Recording"], live: false },
  { name: "Design review", meta: "1h 06", start: 24, span: 21, artifacts: ["Recording", "Transcript"], live: false },
  { name: "Standup", meta: "11 min", start: 55, span: 9, artifacts: [], live: false },
  { name: "Live now", meta: "4 joined", start: 72, span: 29, artifacts: [], live: true },
];

const PERSISTENT = ["Chat", "Whiteboard", "Files", "Members"] as const;

export function SpaceTimeline() {
  return (
    <figure className="tl" aria-hidden="true">
      <figcaption className="tl-head">
        <span className="tl-title">Space · design-lab</span>
        <span className="tl-age">open for 14 months</span>
      </figcaption>

      <ol className="tl-rail">
        {EPISODES.map((episode) => (
          <li className={episode.live ? "tl-episode tl-episode-live" : "tl-episode"} key={episode.name} style={{ "--start": episode.start, "--span": episode.span } as CSSProperties}>
            <span className="tl-episode-bar" />
            <span className="tl-episode-name">{episode.name}</span>
            <span className="tl-episode-meta">{episode.meta}</span>
            {episode.artifacts.length > 0 ? (
              <span className="tl-artifacts">
                {episode.artifacts.map((artifact) => (
                  <span className="tl-artifact" key={artifact}>
                    {artifact}
                  </span>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="tl-persist">
        <span className="tl-persist-label">Stays in the Space, between all of them</span>
        <div className="tl-persist-bands">
          {PERSISTENT.map((band) => (
            <span className="tl-band" key={band}>
              {band}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}

const MEMBERS = [
  { initial: "A", tone: "green" },
  { initial: "M", tone: "yellow" },
  { initial: "R", tone: "blue" },
  { initial: "K", tone: "pink" },
] as const;

export function SpaceLinkCard() {
  return (
    <div className="cv-link" aria-hidden="true">
      <div className="cv-link-bar">
        <span className="cv-link-url">
          chalk.q9labs.ai/space/<b>design-lab</b>
        </span>
        <span className="cv-link-copy">Copy link</span>
      </div>

      <div className="cv-link-row">
        <span className="cv-link-members">
          {MEMBERS.map((member) => (
            <span className={`cv-avatar cv-avatar-${member.tone}`} key={member.initial}>
              {member.initial}
            </span>
          ))}
          <span className="cv-avatar cv-avatar-more">+7</span>
        </span>
        <span className="cv-link-live">
          <span className="cv-dot" /> Live now
        </span>
      </div>

      <div className="cv-link-surfaces">
        {PERSISTENT.map((surface) => (
          <span className="cv-link-surface" key={surface}>
            {surface}
          </span>
        ))}
      </div>
    </div>
  );
}
