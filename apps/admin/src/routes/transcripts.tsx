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
import { format } from "date-fns"

export const Route = createFileRoute("/transcripts")({
  component: TranscriptsPage,
})

const statusColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  completed: "default",
  processing: "outline",
  pending: "secondary",
  failed: "destructive",
}

function TranscriptsPage() {
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "transcripts"],
    queryFn: () => api.listTranscripts(),
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Transcripts</h1>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    )
  }

  const transcripts = data ?? []

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Transcripts</h1>
      {transcripts.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">No transcripts found.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Room</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Words</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
	            {transcripts.map((t) => (
	              <>
                <TableRow
                  key={t.id}
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                >
                  <TableCell>{t.room_name || "—"}</TableCell>
                  <TableCell>{t.tenant_name}</TableCell>
	                  <TableCell>
	                    <Badge variant={statusColors[t.status ?? ""] ?? "outline"}>{t.status}</Badge>
	                  </TableCell>
                  <TableCell>{t.provider || "—"}</TableCell>
                  <TableCell>{t.word_count ?? "—"}</TableCell>
                  <TableCell>{format(new Date(t.created_at), "PPp")}</TableCell>
                </TableRow>
                {expanded === t.id && (
                  <TableRow key={`${t.id}-expanded`}>
                    <TableCell colSpan={6} className="bg-muted/50">
                      <div className="p-3 space-y-3">
                        {t.summary && (
                          <div>
                            <div className="text-xs font-semibold mb-1">Summary</div>
                            <p className="text-sm">{t.summary}</p>
                          </div>
                        )}
                        {t.action_items && t.action_items.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold mb-1">Action Items</div>
                            <ul className="list-disc list-inside text-sm space-y-0.5">
	                              {t.action_items.map((item, i) => (
	                                <li key={i}>{item}</li>
	                              ))}
                            </ul>
                          </div>
                        )}
                        {t.error_message && (
                          <div>
                            <div className="text-xs font-semibold text-destructive mb-1">Error</div>
                            <p className="text-sm text-destructive">{t.error_message}</p>
                          </div>
                        )}
                        {!t.summary && !t.error_message && (
                          <p className="text-sm text-muted-foreground">No additional details.</p>
                        )}
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
