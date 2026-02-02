import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { StatCard } from "@/components/stat-card"
import { DataTable } from "@/components/data-table"
import { Skeleton } from "@/components/ui/skeleton"

export const Route = createFileRoute("/usage")({
  component: UsagePage,
})

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function formatDuration(seconds: number): string {
  if (!seconds) return "0m"
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function UsagePage() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "usage"],
    queryFn: api.getUsage,
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Usage</h1>
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    )
  }

  const durations = data?.meeting_durations ?? []
  const storage = data?.storage_by_provider ?? []

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Usage</h1>

      <div>
        <h2 className="text-lg font-semibold mb-3">Storage by Provider</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {storage.length === 0 ? (
            <p className="text-muted-foreground col-span-3">No storage data.</p>
          ) : (
            storage.map((s: any) => (
              <StatCard
                key={s.storage_provider}
                title={s.storage_provider}
                value={formatBytes(s.total_bytes)}
                description={`${s.recording_count} recordings`}
              />
            ))
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">Meeting Duration by Tenant</h2>
        <DataTable
          data={durations}
          columns={[
            { key: "tenant_name", header: "Tenant" },
            {
              key: "total_duration_seconds",
              header: "Total Duration",
              render: (r) => formatDuration(r.total_duration_seconds as number),
            },
          ]}
        />
      </div>
    </div>
  )
}
