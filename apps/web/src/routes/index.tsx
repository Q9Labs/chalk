import { createFileRoute } from "@tanstack/react-router";

import { Closing } from "../components/landing/Closing";
import { FrontDoors } from "../components/landing/FrontDoors";
import { Hero } from "../components/landing/Hero";
import { SiteNav } from "../components/landing/Nav";
import { Performance } from "../components/landing/Performance";
import { Platform } from "../components/landing/Platform";
import { SelfHost } from "../components/landing/SelfHost";
import { SpaceModel } from "../components/landing/SpaceModel";

export const Route = createFileRoute("/")({ component: LandingPage });

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
