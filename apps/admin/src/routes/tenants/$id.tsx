import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LimitsTab } from "@/components/tenant-tabs/limits-tab";
import { ConfigTab } from "@/components/tenant-tabs/config-tab";
import { WhiteboardTab } from "@/components/tenant-tabs/whiteboard-tab";
import { ApiKeyTab } from "@/components/tenant-tabs/api-key-tab";
import { DangerTab } from "@/components/tenant-tabs/danger-tab";

export const Route = createFileRoute("/tenants/$id")({
  component: TenantDetailPage,
});

function TenantDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "tenant", id],
    queryFn: () => api.getTenant(id),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin", "tenant", id] });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) {
    return <div className="text-center py-10 text-muted-foreground">Tenant not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{data.name}</h1>
        <Badge variant={data.is_active ? "default" : "secondary"}>{data.is_active ? "active" : "inactive"}</Badge>
      </div>

      <Tabs defaultValue="limits">
        <TabsList>
          <TabsTrigger value="limits">Limits</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="whiteboard">Whiteboard</TabsTrigger>
          <TabsTrigger value="api-key">API Key</TabsTrigger>
          <TabsTrigger value="danger">Danger Zone</TabsTrigger>
        </TabsList>

        <TabsContent value="limits">
          <LimitsTab tenant={data} tenantId={id} onSuccess={invalidate} />
        </TabsContent>

        <TabsContent value="config">
          <ConfigTab tenant={data} tenantId={id} onSuccess={invalidate} />
        </TabsContent>

        <TabsContent value="whiteboard">
          <WhiteboardTab tenant={data} tenantId={id} onSuccess={invalidate} />
        </TabsContent>

        <TabsContent value="api-key">
          <ApiKeyTab tenantId={id} apiKeyHash={data.api_key_hash} />
        </TabsContent>

        <TabsContent value="danger">
          <DangerTab tenant={data} tenantId={id} onSuccess={invalidate} onDelete={() => navigate({ to: "/tenants" })} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
