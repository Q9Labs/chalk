import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { JsonViewer } from "@/components/json-viewer"
import { format } from "date-fns"

export const Route = createFileRoute("/webhooks")({
  component: WebhooksPage,
})

const statusColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  delivered: "default",
  pending: "outline",
  sending: "outline",
  failed: "destructive",
}

function WebhooksPage() {
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "webhooks"],
    queryFn: () => api.listWebhooks(),
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Webhook Deliveries</h1>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    )
  }

  const deliveries = data ?? []

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Webhook Deliveries</h1>
      {deliveries.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">No webhook deliveries found.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
	            {deliveries.map((d) => (
	              <>
                <TableRow
                  key={d.id}
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                >
                  <TableCell className="font-mono text-xs">{d.event_type}</TableCell>
                  <TableCell>{d.tenant_name}</TableCell>
	                  <TableCell>
	                    <Badge variant={statusColors[d.status ?? ""] ?? "outline"}>{d.status}</Badge>
	                  </TableCell>
                  <TableCell>{d.attempts}/{d.max_attempts}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-xs">{d.webhook_url}</TableCell>
                  <TableCell>{format(new Date(d.created_at), "PPp")}</TableCell>
                </TableRow>
                {expanded === d.id && (
                  <TableRow key={`${d.id}-expanded`}>
                    <TableCell colSpan={6} className="bg-muted/50">
                      <div className="p-3 space-y-3">
                        {d.last_error && (
                          <div>
                            <div className="text-xs font-semibold text-destructive mb-1">Last Error</div>
                            <p className="text-sm text-destructive">{d.last_error}</p>
                          </div>
                        )}
                        <div>
                          <div className="text-xs font-semibold mb-1">Payload</div>
                          <JsonViewer data={typeof d.payload === "string" ? JSON.parse(d.payload) : d.payload} />
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
