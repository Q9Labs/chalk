import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DataTable } from "@/components/data-table"
import { JsonViewer } from "@/components/json-viewer"
import { Skeleton } from "@/components/ui/skeleton"
import { format } from "date-fns"

export const Route = createFileRoute("/rooms/$id")({
  component: RoomDetailPage,
})

function RoomDetailPage() {
  const { id } = Route.useParams()
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "rooms", id],
    queryFn: () => api.getRoom(id),
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  const room = data?.room
  const participants = data?.participants ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{(room?.name as string) || "Unnamed Room"}</h1>
        <Badge variant={room?.status === "active" ? "default" : "secondary"}>
          {room?.status as string}
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Room Info</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <div><span className="text-muted-foreground">ID:</span> {room?.id}</div>
            <div><span className="text-muted-foreground">Tenant:</span> {room?.tenant_name}</div>
            <div><span className="text-muted-foreground">Active Participants:</span> {room?.active_participant_count}</div>
            <div>
              <span className="text-muted-foreground">Created:</span>{" "}
              {room?.created_at ? format(new Date(room.created_at as string), "PPp") : "—"}
            </div>
          </CardContent>
        </Card>

        {room?.config != null && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Config</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonViewer data={typeof room.config === "string" ? JSON.parse(room.config) : room.config} />
            </CardContent>
          </Card>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">Participants ({participants.length})</h2>
        <DataTable
          data={participants}
          columns={[
            { key: "display_name", header: "Name", render: (p) => (p.display_name as string) || "Anonymous" },
            { key: "role", header: "Role", render: (p) => <Badge variant="outline">{p.role as string}</Badge> },
            { key: "external_user_id", header: "External ID" },
            {
              key: "joined_at",
              header: "Joined",
              render: (p) => {
                const v = p.joined_at as { Valid?: boolean; Time?: string } | undefined
                if (!v?.Valid || !v.Time) return "—"
                return format(new Date(v.Time), "PPp")
              },
            },
            {
              key: "left_at",
              header: "Left",
              render: (p) => {
                const v = p.left_at as { Valid?: boolean; Time?: string } | undefined
                if (!v?.Valid || !v.Time) return <Badge variant="default">Active</Badge>
                return format(new Date(v.Time), "PPp")
              },
            },
          ]}
        />
      </div>
    </div>
  )
}
