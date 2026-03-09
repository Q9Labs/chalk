import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

export const Route = createFileRoute("/recordings")({
  component: RecordingsPage,
});

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

const statusColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  recording: "default",
  processing: "outline",
  ready: "default",
  archived: "secondary",
  deleted: "destructive",
  failed: "destructive",
};

function RecordingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "recordings"],
    queryFn: () => api.listRecordings(),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Recordings</h1>
      <DataTable
        data={data ?? []}
        isLoading={isLoading}
        columns={[
          { key: "room_name", header: "Room", render: (r) => (r.room_name as string) || "—" },
          { key: "tenant_name", header: "Tenant" },
          {
            key: "status",
            header: "Status",
            render: (r) => <Badge variant={statusColors[r.status as string] ?? "outline"}>{r.status as string}</Badge>,
          },
          { key: "storage_provider", header: "Storage", render: (r) => (r.storage_provider as string) || "—" },
          { key: "size_bytes", header: "Size", render: (r) => formatBytes(r.size_bytes as number) },
          { key: "duration_seconds", header: "Duration", render: (r) => formatDuration(r.duration_seconds as number | null) },
          {
            key: "created_at",
            header: "Created",
            render: (r) => format(new Date(r.created_at as string), "PPp"),
          },
        ]}
      />
    </div>
  );
}
