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

export const Route = createFileRoute("/audit-logs")({
  component: AuditLogsPage,
})

function AuditLogsPage() {
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "audit-logs"],
    queryFn: () => api.listAuditLogs(),
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Audit Logs</h1>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    )
  }

  const logs = data ?? []

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Audit Logs</h1>
      {logs.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">No audit logs found.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log: any) => (
              <>
                <TableRow
                  key={log.id}
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                >
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">
                      {log.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{log.actor_id || "—"}</TableCell>
                  <TableCell className="text-xs">
                    {log.resource_type ? `${log.resource_type}` : "—"}
                  </TableCell>
                  <TableCell>{log.tenant_name || "—"}</TableCell>
                  <TableCell className="text-xs font-mono">{log.ip_address || "—"}</TableCell>
                  <TableCell>{format(new Date(log.created_at), "PPp")}</TableCell>
                </TableRow>
                {expanded === log.id && log.metadata && (
                  <TableRow key={`${log.id}-expanded`}>
                    <TableCell colSpan={6} className="bg-muted/50">
                      <div className="p-3">
                        <div className="text-xs font-semibold mb-1">Metadata</div>
                        <JsonViewer data={typeof log.metadata === "string" ? JSON.parse(log.metadata) : log.metadata} />
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
