import { createFileRoute } from "@tanstack/react-router";

import { Closing } from "../components/landing/Closing";
import { FrontDoors } from "../components/landing/FrontDoors";
import { Hero } from "../components/landing/Hero";
import { SiteNav } from "../components/landing/Nav";
import { Performance } from "../components/landing/Performance";
import { Platform } from "../components/landing/Platform";
import { SelfHost } from "../components/landing/SelfHost";
import { SpaceModel } from "../components/landing/SpaceModel";
import { buildPublicSiteHead, SITE_ORIGIN } from "../lib/site-head";

const title = "Chalk | Real-time collaboration for products";
const description = "Chalk is the open-source real-time collaboration and communication layer for building persistent Spaces into web, React, and React Native products.";

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
      image: `${SITE_ORIGIN}/images/social/chalk-og-product-20260819.png`,
      provider: { "@id": `${SITE_ORIGIN}/#organization` },
    },
  ],
};

export const Route = createFileRoute("/")({
  head: () => ({
    ...buildPublicSiteHead({
      path: "/",
      title,
      description,
      imageAlt: "Chalk open-source real-time Spaces for mobile and web",
    }),
    scripts: [{ type: "application/ld+json", children: JSON.stringify(structuredData) }],
  }),
  component: LandingPage,
});

function LandingPage() {
  return (
    <div className="site">
      <SiteNav />
      <main>
        <Hero />
        <FrontDoors />
        <SpaceModel />
        <Performance />
        <SelfHost />
        <Platform />
        <Closing />
      </main>
    </div>
  );
}
