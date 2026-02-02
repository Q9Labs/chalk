import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

export function ApiKeyTab({
  tenantId,
  apiKeyHash,
}: {
  tenantId: string
  apiKeyHash?: unknown
}) {
  const [newKey, setNewKey] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => api.rotateKey(tenantId),
    onSuccess: (res) => setNewKey(res.api_key),
  })

  const masked = apiKeyHash
    ? `${String(apiKeyHash).slice(0, 8)}...${"*".repeat(24)}`
    : "No key set"

  return (
    <div className="max-w-md space-y-6 pt-4">
      <div className="grid gap-2">
        <Label>Current Key Hash</Label>
        <code className="rounded bg-muted px-3 py-2 text-sm font-mono block">
          {masked}
        </code>
      </div>

      {newKey && (
        <div className="grid gap-2 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950">
          <Label className="text-green-700 dark:text-green-400">
            New API Key (copy now, shown only once)
          </Label>
          <div className="flex gap-2">
            <Input readOnly value={newKey} className="font-mono text-xs" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard.writeText(newKey)}
            >
              Copy
            </Button>
          </div>
        </div>
      )}

      <AlertDialog>
        <AlertDialogTrigger
          render={<Button variant="destructive" />}
        >
          Rotate API Key
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate API Key?</AlertDialogTitle>
            <AlertDialogDescription>
              The current API key will stop working immediately. All integrations
              using the old key will break until updated with the new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Rotating..." : "Rotate Key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {mutation.isError && (
        <p className="text-sm text-destructive">
          {mutation.error?.message ?? "Failed to rotate key."}
        </p>
      )}
    </div>
  )
}
