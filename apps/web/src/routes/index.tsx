import { createFileRoute } from "@tanstack/react-router";

import { AfterSection } from "../components/landing/AfterSection";
import { CtaSection } from "../components/landing/CtaSection";
import { EmbedSection } from "../components/landing/EmbedSection";
import { Hero } from "../components/landing/Hero";
import { LinkSection } from "../components/landing/LinkSection";
import { OpenSourceSection } from "../components/landing/OpenSourceSection";
import { SpeedSection } from "../components/landing/SpeedSection";
import { SiteFooter } from "../components/site/SiteFooter";
import { SiteNav } from "../components/site/SiteNav";
import { SiteRoot } from "../components/site/theme";
import { buildPublicSiteHead, SITE_ORIGIN, SOCIAL_IMAGE_URL } from "../lib/site-head";
import landingCss from "../styles/landing.css?url";

const title = "Chalk | Calls for your team, and inside your product";
const description = "Start a call and share one link that keeps working next week, or render the same call in your own app with a few lines of React. Chalk is open source.";

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_ORIGIN}/#organization`,
      name: "Q9 Labs",
      url: SITE_ORIGIN,
      logo: `${SITE_ORIGIN}/brand/chalk/chalk-icon-512.png`,
      sameAs: ["https://github.com/Q9Labs"],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      name: "Chalk",
      url: `${SITE_ORIGIN}/`,
      description,
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_ORIGIN}/#software`,
      name: "Chalk",
      url: `${SITE_ORIGIN}/`,
      description,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web, iOS, Android",
      image: SOCIAL_IMAGE_URL,
      provider: { "@id": `${SITE_ORIGIN}/#organization` },
    },
  ],
};

export const Route = createFileRoute("/")({
  head: () => {
    const head = buildPublicSiteHead({
      path: "/",
      title,
      description,
      imageAlt: "Chalk: calls for your team, and inside your product",
    });
    return { ...head, links: [...head.links, { rel: "stylesheet", href: landingCss }] };
  },
  component: LandingPage,
});

function LandingPage() {
  return (
    <SiteRoot>
      <SiteNav />
      <main>
        <Hero />
        <LinkSection />
        <AfterSection />
        <SpeedSection />
        <EmbedSection />
        <OpenSourceSection />
        <CtaSection />
      </main>
      <SiteFooter dither />
      {/* In the body, not the head, so it can't shift the head's scripts out of step during hydration. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
    </SiteRoot>
  );
}
