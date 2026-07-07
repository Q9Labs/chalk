import { createFileRoute } from "@tanstack/react-router";
import { Hero, SiteNav } from "../components/landing/Hero";
import { FrontDoors, PerfBudget, SelfHost } from "../components/landing/Sections";
import { Closing, FeatureGrid } from "../components/landing/Closing";

export const Route = createFileRoute("/")({ component: LandingPage });

function LandingPage() {
  return (
    <>
      <SiteNav />
      <main>
        <Hero />
        <FrontDoors />
        <PerfBudget />
        <SelfHost />
        <FeatureGrid />
        <Closing />
      </main>
    </>
  );
}
