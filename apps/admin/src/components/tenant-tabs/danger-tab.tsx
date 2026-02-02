import { useMutation } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
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

export function DangerTab({
  tenant,
  tenantId,
  onSuccess,
  onDelete,
}: {
  tenant: Record<string, unknown>
  tenantId: string
  onSuccess: () => void
  onDelete: () => void
}) {
  const isActive = tenant.is_active === true

  const toggleMutation = useMutation({
    mutationFn: () =>
      isActive ? api.deactivateTenant(tenantId) : api.activateTenant(tenantId),
    onSuccess,
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteTenant(tenantId),
    onSuccess: onDelete,
  })

  return (
    <div className="max-w-md space-y-8 pt-4">
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Status</h3>
        <p className="text-sm text-muted-foreground">
          Tenant is currently{" "}
          <strong>{isActive ? "active" : "inactive"}</strong>.
          {isActive
            ? " Deactivating will prevent new rooms from being created."
            : " Activating will allow the tenant to create rooms again."}
        </p>
        <Button
          variant={isActive ? "outline" : "default"}
          onClick={() => toggleMutation.mutate()}
          disabled={toggleMutation.isPending}
        >
          {toggleMutation.isPending
            ? "Updating..."
            : isActive
              ? "Deactivate Tenant"
              : "Activate Tenant"}
        </Button>
        {toggleMutation.isError && (
          <p className="text-sm text-destructive">
            {toggleMutation.error?.message ?? "Failed to update status."}
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-destructive/30 p-4">
        <h3 className="text-sm font-medium text-destructive">Delete Tenant</h3>
        <p className="text-sm text-muted-foreground">
          This action is irreversible. All rooms, recordings, and data
          associated with this tenant will be permanently deleted.
        </p>
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" />}>
            Delete Tenant
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this tenant?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete <strong>{String(tenant.name)}</strong>{" "}
                and all associated data. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {deleteMutation.isError && (
          <p className="text-sm text-destructive">
            {deleteMutation.error?.message ?? "Failed to delete."}
          </p>
        )}
      </div>
    </div>
  )
}
