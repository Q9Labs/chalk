import { createFileRoute } from "@tanstack/react-router";
import { Download } from "lucide-react";

import { DocsLayout } from "@/features/docs/components";

export const Route = createFileRoute("/docs/api-reference")({
  component: ApiReference,
});

function ApiReference() {
  return (
    <DocsLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold text-foreground">API Reference</h1>
          <p className="mt-4 text-lg text-muted-foreground">Complete REST API documentation for the Chalk backend.</p>
        </div>

        <div className="p-6 rounded-lg border border-border bg-card">
          <h2 className="text-xl font-semibold text-foreground mb-4">Base URL</h2>
          <code className="px-3 py-2 rounded bg-muted text-sm font-mono">https://chalk-api.q9labs.ai/api/v1</code>
        </div>

        <div className="space-y-6">
          <h2 className="text-2xl font-semibold text-foreground border-b pb-2">Endpoints</h2>

          <EndpointSection
            title="Authentication"
            endpoints={[
              {
                method: "POST",
                path: "/auth/token",
                description: "Exchange API key for JWT tokens",
              },
              {
                method: "POST",
                path: "/auth/refresh",
                description: "Refresh access token using refresh token",
              },
            ]}
          />

          <EndpointSection
            title="Tenants"
            endpoints={[
              {
                method: "POST",
                path: "/tenants",
                description: "Create new tenant (organization)",
              },
              {
                method: "GET",
                path: "/tenants/:id",
                description: "Get tenant details",
              },
              {
                method: "PATCH",
                path: "/tenants/:id",
                description: "Update tenant settings",
              },
              {
                method: "POST",
                path: "/tenants/:id/rotate-key",
                description: "Rotate API key",
              },
            ]}
          />

          <EndpointSection
            title="Rooms"
            endpoints={[
              {
                method: "POST",
                path: "/rooms",
                description: "Create new room",
              },
              {
                method: "GET",
                path: "/rooms",
                description: "List all rooms",
              },
              {
                method: "GET",
                path: "/rooms/:id",
                description: "Get room details",
              },
              {
                method: "PATCH",
                path: "/rooms/:id",
                description: "Update room settings",
              },
              {
                method: "POST",
                path: "/rooms/:id/end",
                description: "End active room session",
              },
              {
                method: "DELETE",
                path: "/rooms/:id",
                description: "Delete room",
              },
            ]}
          />

          <EndpointSection
            title="Participants"
            endpoints={[
              {
                method: "POST",
                path: "/rooms/:id/participants",
                description: "Add participant to room (returns auth tokens)",
              },
              {
                method: "GET",
                path: "/rooms/:id/participants",
                description: "List room participants",
              },
              {
                method: "DELETE",
                path: "/rooms/:id/participants/:pid",
                description: "Remove participant from room",
              },
              {
                method: "POST",
                path: "/rooms/:id/participants/:pid/token",
                description: "Refresh participant tokens",
              },
            ]}
          />

          <EndpointSection
            title="Recordings"
            endpoints={[
              {
                method: "POST",
                path: "/rooms/:id/recordings/start",
                description: "Start recording",
              },
              {
                method: "POST",
                path: "/rooms/:id/recordings/stop",
                description: "Stop recording",
              },
              {
                method: "GET",
                path: "/recordings",
                description: "List all recordings",
              },
              {
                method: "GET",
                path: "/recordings/:id",
                description: "Get recording details",
              },
              {
                method: "GET",
                path: "/recordings/:id/download",
                description: "Get presigned download URL",
              },
            ]}
          />
        </div>

        <div className="p-6 rounded-lg border border-border bg-muted/30">
          <h2 className="text-xl font-semibold text-foreground mb-4">OpenAPI Specification</h2>
          <p className="text-muted-foreground mb-4">For complete request/response schemas, authentication details, and error codes, download the full OpenAPI specification.</p>
          <a href="/openapi.yaml" download="chalk-openapi.yaml" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-medium transition-colors">
            <Download size={16} />
            Download OpenAPI Spec
          </a>
        </div>
      </div>
    </DocsLayout>
  );
}

interface Endpoint {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  description: string;
}

const methodColors = {
  GET: "bg-green-500/10 text-green-600 dark:text-green-400",
  POST: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  PATCH: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  DELETE: "bg-red-500/10 text-red-600 dark:text-red-400",
};

function EndpointSection({ title, endpoints }: { title: string; endpoints: Endpoint[] }) {
  return (
    <div>
      <h3 className="text-lg font-medium text-foreground mb-3">{title}</h3>
      <div className="space-y-2">
        {endpoints.map((endpoint) => (
          <div key={`${endpoint.method}-${endpoint.path}`} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
            <span className={`px-2 py-1 rounded text-xs font-mono font-semibold ${methodColors[endpoint.method]}`}>{endpoint.method}</span>
            <code className="font-mono text-sm text-foreground">{endpoint.path}</code>
            <span className="text-sm text-muted-foreground ml-auto">{endpoint.description}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
