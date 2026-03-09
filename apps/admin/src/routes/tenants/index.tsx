import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { api } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export const Route = createFileRoute("/tenants/")({
  component: TenantsPage,
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const columns = [
  { key: "name", header: "Name" },
  {
    key: "is_active",
    header: "Status",
    render: (row: Record<string, unknown>) => <Badge variant={row.is_active ? "default" : "secondary"}>{row.is_active ? "active" : "inactive"}</Badge>,
  },
  { key: "active_rooms", header: "Active Rooms" },
  { key: "total_rooms", header: "Total Rooms" },
  { key: "total_recordings", header: "Recordings" },
  {
    key: "storage_bytes",
    header: "Storage",
    render: (row: Record<string, unknown>) => formatBytes(Number(row.storage_bytes ?? 0)),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row: Record<string, unknown>) => (row.created_at ? format(new Date(String(row.created_at)), "PPp") : "\u2014"),
  },
];

function TenantsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: () => api.listTenants(),
  });

  const createMutation = useMutation({
    mutationFn: api.createTenant,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
      setOpen(false);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tenants</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>Create Tenant</DialogTrigger>
          <DialogContent>
            <CreateTenantForm onSubmit={(data) => createMutation.mutate(data)} isPending={createMutation.isPending} />
          </DialogContent>
        </Dialog>
      </div>

      <DataTable data={data ?? []} columns={columns} isLoading={isLoading} emptyMessage="No tenants found." onRowClick={(row) => navigate({ to: "/tenants/$id", params: { id: String(row.id) } })} />
    </div>
  );
}

function CreateTenantForm({ onSubmit, isPending }: { onSubmit: (data: { name: string; max_concurrent_rooms?: number; max_participants_per_room?: number; max_recording_duration_minutes?: number }) => void; isPending: boolean }) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get("name")).trim();
    if (!name) return;

    const toNum = (key: string) => {
      const v = String(fd.get(key)).trim();
      return v ? Number(v) : undefined;
    };

    onSubmit({
      name,
      max_concurrent_rooms: toNum("max_concurrent_rooms"),
      max_participants_per_room: toNum("max_participants_per_room"),
      max_recording_duration_minutes: toNum("max_recording_duration_minutes"),
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Create Tenant</DialogTitle>
        <DialogDescription>Add a new tenant to the platform.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="Acme Corp" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="max_concurrent_rooms">Max Concurrent Rooms</Label>
          <Input id="max_concurrent_rooms" name="max_concurrent_rooms" type="number" placeholder="10" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="max_participants_per_room">Max Participants per Room</Label>
          <Input id="max_participants_per_room" name="max_participants_per_room" type="number" placeholder="50" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="max_recording_duration_minutes">Max Recording Duration (min)</Label>
          <Input id="max_recording_duration_minutes" name="max_recording_duration_minutes" type="number" placeholder="60" />
        </div>
      </div>

      <DialogFooter>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating..." : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}
