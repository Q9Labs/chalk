import { createFileRoute } from "@tanstack/react-router";
import { ArtifactsPage } from "../components/dashboard/ArtifactsPage";

export const Route = createFileRoute("/_app/artifacts")({ component: ArtifactsPage });
