import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { StatCard } from "@/components/stat-card"
import { Skeleton } from "@/components/ui/skeleton"

export const Route = createFileRoute("/")({
  component: OverviewPage,
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function OverviewPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: api.getOverview,
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Overview</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    )
  }

  const overview = data?.overview
  const webhookStats = data?.webhook_stats
  const storageStats = data?.storage_stats as { storage_provider: string; total_bytes: number; recording_count: number }[] | undefined

  const totalStorage = Number(overview?.total_storage_bytes ?? 0)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Active Tenants" value={overview?.active_tenants ?? 0} />
        <StatCard title="Active Rooms" value={overview?.active_rooms ?? 0} />
        <StatCard title="Total Rooms" value={overview?.total_rooms ?? 0} />
        <StatCard title="Total Recordings" value={overview?.total_recordings ?? 0} />
        <StatCard title="Total Storage" value={formatBytes(totalStorage)} />
        <StatCard title="Active Participants" value={overview?.active_participants ?? 0} />
      </div>

      {webhookStats && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Webhook Deliveries</h2>
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard title="Delivered" value={webhookStats.delivered} />
            <StatCard title="Failed" value={webhookStats.failed} />
            <StatCard title="Pending" value={webhookStats.pending} />
            <StatCard title="Total" value={webhookStats.total} />
          </div>
        </div>
      )}

      {storageStats && storageStats.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Storage Breakdown</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {storageStats.map((s) => (
              <StatCard
                key={s.storage_provider}
                title={s.storage_provider}
                value={formatBytes(s.total_bytes)}
                description={`${s.recording_count} recordings`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
